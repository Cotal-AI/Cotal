param(
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$ReadyFile,
    [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $OutputDir -PathType Container)) {
    throw 'OutputDir must already exist.'
}
$PidFile = [IO.Path]::GetFullPath($PidFile)
$ReadyFile = [IO.Path]::GetFullPath($ReadyFile)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class CotalWindowPaintSampler
{
    public class Bounds
    {
        public int x, y, width, height;
    }
    public class Sample
    {
        public double atMs, durationMs;
        public int logoPixels, bluePixels, goldPixels, coralPixels;
        public double paperFraction;
        public bool authenticLogo;
        public string headerCrop;
        public Bounds bounds;
        public string error;
    }
    public class Result
    {
        public double? visibleAtMs, paintedAtMs, visibleToPaintMs;
        public double? processStartToVisibleMs;
        public string processStartedAt, firstVisibleAt;
        public bool anyFrameNeitherPaperNorContent;
        public List<Sample> samples = new List<Sample>();
        public Bounds bounds;
        public string outcome = "timeout";
        public string platform = "windows";
        public string method = "EnumWindows/IsWindowVisible/GetWindowRect + System.Drawing.CopyFromScreen RGB crop";
        public string precisionCaveat = "Stopwatch monotonic milliseconds since sampler preparation, before ready. processStartToVisibleMs separately uses target PID StartTime UTC and DateTime.UtcNow at first native visibility, and is subject to wall-clock adjustments. Visibility is native window visibility, not proof of presented pixels. Screen copies measure on-screen RGB, including occlusion, without compositor presentation timestamps. Sampling targets 20ms start-to-start but capture and scheduling can exceed it. Header ROI is window-relative x=[15,180), y=[40,150), excluding native icon/titlebar. Authentic logo requires at least 3 pixels each near #4d69e6, #e5c776, #e38c6e and at least 0.65 paper fraction near #fffcee, using per-channel RGB tolerance 25 for brand colors and 5 for paper. Coordinates use per-monitor DPI awareness where supported.";
        public string error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    private static readonly Stopwatch Clock = new Stopwatch();

    private static bool Near(Color pixel, int r, int g, int b, int tolerance = 25)
    {
        return Math.Abs(pixel.R - r) <= tolerance && Math.Abs(pixel.G - g) <= tolerance && Math.Abs(pixel.B - b) <= tolerance;
    }

    public static void Prepare()
    {
        // Compile/load the native and drawing helper before the ready handshake.
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { }
        EnumWindows(delegate(IntPtr h, IntPtr d) { return true; }, IntPtr.Zero);
        using (Bitmap warm = new Bitmap(1, 1)) { warm.GetPixel(0, 0); }
        Clock.Restart();
    }

    private static Bounds Find(uint target)
    {
        Bounds found = null;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != target || !IsWindowVisible(hwnd)) return true;
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            int width = r.Right - r.Left, height = r.Bottom - r.Top;
            if (width < 400 || height < 300) return true;
            found = new Bounds { x = r.Left, y = r.Top, width = width, height = height };
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static Result Run(string pidFile, string outputDir)
    {
        Result result = new Result();
        bool savedVisible = false;
        Bitmap firstVisibleImage = null;
        List<Bitmap> nonpaintHeaders = new List<Bitmap>();
        List<Sample> nonpaintSamples = new List<Sample>();
        uint target = 0;
        try
        {
            // The parent starts the application only after seeing ReadyFile.
            while (Clock.Elapsed.TotalMilliseconds < 45000)
            {
                string text = null;
                try { if (File.Exists(pidFile)) text = File.ReadAllText(pidFile).Trim(); }
                catch (IOException) { }
                bool decimalOnly = !String.IsNullOrEmpty(text);
                if (decimalOnly)
                    foreach (char c in text) if (c < '0' || c > '9') { decimalOnly = false; break; }
                if (decimalOnly && UInt32.TryParse(text, out target) && target > 0) break;
                Thread.Sleep(5);
            }
            if (target == 0) throw new TimeoutException("Target PID was not received.");
            DateTime processStarted;
            using (Process process = Process.GetProcessById(checked((int)target)))
                processStarted = process.StartTime.ToUniversalTime();
            result.processStartedAt = processStarted.ToString("o");
            while (Clock.Elapsed.TotalMilliseconds < 45000)
            {
                double started = Clock.Elapsed.TotalMilliseconds;
                Bounds bounds = Find(target);
                if (bounds != null)
                {
                    double visible = Clock.Elapsed.TotalMilliseconds;
                    if (!result.visibleAtMs.HasValue)
                    {
                        DateTime firstVisible = DateTime.UtcNow;
                        result.visibleAtMs = visible;
                        result.firstVisibleAt = firstVisible.ToString("o");
                        result.processStartToVisibleMs = (firstVisible - processStarted).TotalMilliseconds;
                    }
                    result.bounds = bounds;
                    Sample sample = new Sample { atMs = visible, bounds = bounds };
                    result.samples.Add(sample);
                    try
                    {
                        using (Bitmap bitmap = new Bitmap(bounds.width, bounds.height, PixelFormat.Format32bppArgb))
                        {
                            using (Graphics graphics = Graphics.FromImage(bitmap))
                                graphics.CopyFromScreen(bounds.x, bounds.y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
                            // Timestamp the completed screen copy, before pixel scanning or PNG I/O.
                            double captured = Clock.Elapsed.TotalMilliseconds;
                            sample.atMs = captured;
                            int paperPixels = 0;
                            for (int y = 40; y < 150; y++)
                                for (int x = 15; x < 180; x++)
                                {
                                    Color pixel = bitmap.GetPixel(x, y);
                                    if (Near(pixel, 77, 105, 230)) sample.bluePixels++;
                                    if (Near(pixel, 229, 199, 118)) sample.goldPixels++;
                                    if (Near(pixel, 227, 140, 110)) sample.coralPixels++;
                                    if (Near(pixel, 255, 252, 238, 5)) paperPixels++;
                                }
                            sample.logoPixels = sample.bluePixels + sample.goldPixels + sample.coralPixels;
                            sample.paperFraction = paperPixels / (165.0 * 110);
                            sample.authenticLogo = sample.bluePixels >= 3 && sample.goldPixels >= 3 &&
                                sample.coralPixels >= 3 && sample.paperFraction >= 0.65;
                            if (!sample.authenticLogo)
                            {
                                if (1 - sample.paperFraction > 0.1) result.anyFrameNeitherPaperNorContent = true;
                                nonpaintHeaders.Add(bitmap.Clone(new Rectangle(15, 40, 165, 110), bitmap.PixelFormat));
                                nonpaintSamples.Add(sample);
                                sample.headerCrop = "nonpaint-header-" + result.samples.Count.ToString("D4") + ".png";
                            }
                            if (!savedVisible)
                            {
                                firstVisibleImage = (Bitmap)bitmap.Clone();
                                savedVisible = true;
                            }
                            if (sample.authenticLogo)
                            {
                                result.paintedAtMs = captured;
                                result.visibleToPaintMs = captured - result.visibleAtMs.Value;
                                bitmap.Save(Path.Combine(outputDir, "first-painted.png"), ImageFormat.Png);
                                result.outcome = "painted";
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        sample.error = ex.GetType().Name + ": " + ex.Message;
                        throw;
                    }
                    sample.durationMs = Clock.Elapsed.TotalMilliseconds - started;
                    if (result.outcome == "painted") break;
                }
                double remaining = 20 - (Clock.Elapsed.TotalMilliseconds - started);
                if (remaining > 0) Thread.Sleep((int)Math.Ceiling(remaining));
            }
        }
        catch (Exception ex)
        {
            result.outcome = "error";
            result.error = ex.GetType().Name + ": " + ex.Message;
        }
        try
        {
            if (firstVisibleImage != null)
                firstVisibleImage.Save(Path.Combine(outputDir, "first-visible.png"), ImageFormat.Png);
            for (int i = 0; i < nonpaintHeaders.Count; i++)
                nonpaintHeaders[i].Save(Path.Combine(outputDir, nonpaintSamples[i].headerCrop), ImageFormat.Png);
        }
        catch (Exception ex)
        {
            result.outcome = "error";
            result.error = ex.GetType().Name + ": " + ex.Message;
        }
        finally
        {
            if (firstVisibleImage != null) firstVisibleImage.Dispose();
            foreach (Bitmap header in nonpaintHeaders) header.Dispose();
        }
        return result;
    }
}
'@

[CotalWindowPaintSampler]::Prepare()
[IO.File]::WriteAllText($ReadyFile, "ready`n")
$result = [CotalWindowPaintSampler]::Run($PidFile, $OutputDir)
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDir 'first-paint.json') -Encoding UTF8
if ($result.outcome -ne 'painted') { exit 1 }
exit 0
