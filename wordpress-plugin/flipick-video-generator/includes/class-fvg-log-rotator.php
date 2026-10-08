<?php
defined('ABSPATH') || exit;

/**
 * Log file with rotation.
 *
 *   - Every day at 00:05:00 (ROTATE_AT, in the configured timezone) the current file is closed, zipped and a new one started.
 *   - Whenever a file would pass 10 MB it is zipped at once and a new file is started, whatever the time.
 *
 * Archives: <name>-YYYY-MM-DD.zip (daily; the "log day", which runs 00:05 to 00:05) and <name>-YYYY-MM-DD-HHmmss.zip (size).
 *
 * Safe under concurrency: every write and every rotation holds one lock file, and a rotation first renames the live file (atomic),
 * so no line is lost or split. Rotation is also checked on every write, so a missed cron run never skips a day; a scheduled job
 * (Magento cron / WP-Cron) calls rotateIfDue() so a quiet system still rotates at 00:05. A crash between the rename and the zip
 * leaves a ".rotating-*" file that the next call zips. Nothing in here ever throws: logging must not break the application.
 */
final class FVG_Log_Rotator
{
    public const DEFAULT_MAX_BYTES = 10485760; // 10 MB
    public const DEFAULT_ROTATE_AT = '00:05';

    /** @var string */
    private $dir;
    /** @var string */
    private $name;
    /** @var int */
    private $maxBytes;
    /** @var string */
    private $rotateAt;
    /** @var \DateTimeZone */
    private $timezone;
    /** @var int */
    private $retentionDays;
    /** @var callable|null */
    private $clock;

    public function __construct(
        string $dir,
        string $name,
        int $maxBytes = self::DEFAULT_MAX_BYTES,
        string $rotateAt = self::DEFAULT_ROTATE_AT,
        ?\DateTimeZone $timezone = null,
        int $retentionDays = 0,
        ?callable $clock = null
    ) {
        $this->dir = rtrim($dir, '/\\');
        $this->name = $name;
        $this->maxBytes = max(1, $maxBytes);
        $this->rotateAt = preg_match('/^\d{1,2}:\d{2}$/', $rotateAt) ? $rotateAt : self::DEFAULT_ROTATE_AT;
        $this->timezone = $timezone ?: new \DateTimeZone(date_default_timezone_get());
        $this->retentionDays = max(0, $retentionDays);
        $this->clock = $clock;
    }

    public function getLogFile(): string
    {
        return $this->dir . '/' . $this->name . '.log';
    }

    /** Appends text (one or more complete lines), rotating first when a rotation is due. Returns false if it could not write. */
    public function append(string $text): bool
    {
        try {
            if (!$this->ensureDir()) {
                return false;
            }
            return (bool) $this->withLock(function () use ($text) {
                $this->rotateIfDueLocked();
                $file = $this->getLogFile();
                clearstatcache(true, $file);
                $size = is_file($file) ? (int) filesize($file) : 0;
                if ($size > 0 && $size + strlen($text) > $this->maxBytes) {
                    $this->rotateLocked('size');
                }
                return file_put_contents($file, $text, FILE_APPEND) !== false;
            });
        } catch (\Throwable $e) {
            error_log('[' . $this->name . '] log write failed: ' . $e->getMessage());
            return false;
        }
    }

    /** For the scheduled job: rotates the file if its day has ended. Returns the archive path, or null if nothing was due. */
    public function rotateIfDue(): ?string
    {
        try {
            if (!$this->ensureDir()) {
                return null;
            }
            return $this->withLock(function () {
                return $this->rotateIfDueLocked();
            });
        } catch (\Throwable $e) {
            error_log('[' . $this->name . '] log rotation failed: ' . $e->getMessage());
            return null;
        }
    }

    /** Rotates now whatever the time (used by tests and by an admin action). */
    public function rotateNow(string $reason = 'manual'): ?string
    {
        try {
            if (!$this->ensureDir()) {
                return null;
            }
            return $this->withLock(function () use ($reason) {
                return $this->rotateLocked($reason);
            });
        } catch (\Throwable $e) {
            error_log('[' . $this->name . '] log rotation failed: ' . $e->getMessage());
            return null;
        }
    }

    /** The most recent rotation moment that is not in the future (today 00:05:00, or yesterday's if it is earlier than that). */
    public function lastBoundary(?int $now = null): int
    {
        $now = $now ?? $this->now();
        [$h, $m] = array_map('intval', explode(':', $this->rotateAt));
        $at = (new \DateTimeImmutable('@' . $now))->setTimezone($this->timezone)->setTime($h, $m, 0);
        if ($at->getTimestamp() > $now) {
            $at = $at->modify('-1 day');
        }
        return $at->getTimestamp();
    }

    /** The next rotation moment after $from. */
    public function nextBoundary(?int $from = null): int
    {
        $from = $from ?? $this->now();
        $last = (new \DateTimeImmutable('@' . $this->lastBoundary($from)))->setTimezone($this->timezone);
        return $last->modify('+1 day')->getTimestamp();
    }

    private function now(): int
    {
        return $this->clock ? (int) call_user_func($this->clock) : time();
    }

    private function ensureDir(): bool
    {
        return is_dir($this->dir) || @mkdir($this->dir, 0775, true) || is_dir($this->dir);
    }

    /** @return mixed */
    private function withLock(callable $fn)
    {
        $lock = @fopen($this->dir . '/.' . $this->name . '.lock', 'c');
        if ($lock === false) {
            return $fn(); // no lock file possible (read-only directory?): still try, the write will report the failure
        }
        try {
            flock($lock, LOCK_EX);
            return $fn();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function rotateIfDueLocked(): ?string
    {
        $this->zipLeftovers();
        $file = $this->getLogFile();
        clearstatcache(true, $file);
        if (!is_file($file) || filesize($file) === 0) {
            return null;
        }
        if ((int) filemtime($file) >= $this->lastBoundary()) {
            return null; // written since the last 00:05: its day has not ended
        }
        return $this->rotateLocked('daily');
    }

    private function rotateLocked(string $reason): ?string
    {
        $file = $this->getLogFile();
        clearstatcache(true, $file);
        if (!is_file($file) || filesize($file) === 0) {
            return null;
        }
        $modified = (int) filemtime($file);
        $now = $this->now();
        $tmp = $file . '.rotating-' . gmdate('YmdHis', $now) . '-' . bin2hex(random_bytes(3));
        if (!@rename($file, $tmp)) {
            error_log('[' . $this->name . '] could not rename ' . $file . ' for rotation');
            return null;
        }
        return $this->archive($tmp, $reason, $modified, $now);
    }

    /** Zips a renamed file; on any failure the renamed file stays, to be zipped by the next call. */
    private function archive(string $tmp, string $reason, int $modified, int $now): ?string
    {
        $base = $this->archiveBase($reason, $modified, $now);
        $useZip = class_exists('ZipArchive');
        $target = $this->dir . '/' . $base . ($useZip ? '.zip' : '.log.gz');
        $ok = false;
        try {
            if ($useZip) {
                $zip = new \ZipArchive();
                $partial = $target . '.tmp';
                if ($zip->open($partial, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true) {
                    $zip->addFile($tmp, $base . '.log');
                    if (method_exists($zip, 'setCompressionName')) {
                        $zip->setCompressionName($base . '.log', \ZipArchive::CM_DEFLATE);
                    }
                    $ok = $zip->close() && @rename($partial, $target);
                }
            } else {
                // No zip extension on this PHP: gzip keeps the file small, and the problem is reported.
                error_log('[' . $this->name . '] PHP zip extension missing; archiving as .gz');
                $data = file_get_contents($tmp);
                $ok = $data !== false && file_put_contents($target, gzencode($data, 9)) !== false;
            }
        } catch (\Throwable $e) {
            error_log('[' . $this->name . '] could not archive ' . basename($tmp) . ': ' . $e->getMessage());
        }
        if (!$ok) {
            error_log('[' . $this->name . '] could not archive ' . basename($tmp) . '; it will be retried');
            return null;
        }
        @unlink($tmp);
        $this->prune($now);
        return $target;
    }

    private function archiveBase(string $reason, int $modified, int $now): string
    {
        if ($reason === 'daily') {
            // The log day runs from 00:05 to 00:05, so a line written at 00:03 still belongs to the day before.
            [$h, $m] = array_map('intval', explode(':', $this->rotateAt));
            $day = (new \DateTimeImmutable('@' . ($modified - ($h * 3600 + $m * 60))))->setTimezone($this->timezone)->format('Y-m-d');
            $base = $this->name . '-' . $day;
        } else {
            $base = $this->name . '-' . (new \DateTimeImmutable('@' . $now))->setTimezone($this->timezone)->format('Y-m-d-His');
        }
        $candidate = $base;
        for ($n = 2; is_file($this->dir . '/' . $candidate . '.zip') || is_file($this->dir . '/' . $candidate . '.log.gz'); $n++) {
            $candidate = $base . '-' . $n;
        }
        return $candidate;
    }

    private function zipLeftovers(): void
    {
        foreach ((array) glob($this->dir . '/' . $this->name . '.log.rotating-*') as $left) {
            $this->archive($left, 'daily', (int) @filemtime($left), $this->now());
        }
    }

    private function prune(int $now): void
    {
        if ($this->retentionDays <= 0) {
            return;
        }
        $limit = $now - $this->retentionDays * 86400;
        foreach ((array) glob($this->dir . '/' . $this->name . '-*') as $old) {
            if (preg_match('/\.(zip|gz)$/', $old) && (int) @filemtime($old) < $limit) {
                @unlink($old);
            }
        }
    }
}
