using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    [MTAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "list")
            {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine(new JavaScriptSerializer().Serialize(TargetProcess.List()));
                return 0;
            }
            uint pid;
            ulong creation;
            if (args.Length != 3 || args[0] != "capture" ||
                !UInt32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0 ||
                !UInt64.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out creation))
                throw new ArgumentException("Usage: aural-meeting-audio list | capture <pid> <startedAt>.");

            using (var target = TargetProcess.Open(pid, creation))
            using (var stop = new ManualResetEvent(false))
            {
                var control = new Thread(() => ReadControl(stop));
                control.IsBackground = true;
                control.Start();
                Wasapi.Capture(target, stop, Console.OpenStandardOutput());
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("ERROR " + error.Message.Replace('\r', ' ').Replace('\n', ' '));
            return 1;
        }
    }

    private static void ReadControl(ManualResetEvent stop)
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
                if (line == "stop") break;
        }
        catch (IOException) { }
        try { stop.Set(); }
        catch (ObjectDisposedException) { }
    }
}

internal sealed class TargetProcess : WaitHandle
{
    private const uint QueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private readonly ulong creation;

    public uint Id { get; private set; }
    private string StartedAt { get { return creation.ToString(CultureInfo.InvariantCulture); } }

    private TargetProcess(uint pid, SafeWaitHandle handle, ulong start)
    {
        Id = pid;
        creation = start;
        SafeWaitHandle = handle;
    }

    public static TargetProcess Open(uint pid, ulong? expected = null)
    {
        uint currentSession, targetSession;
        uint currentId = (uint)Process.GetCurrentProcess().Id;
        if (pid == currentId ||
            !ProcessIdToSessionId(currentId, out currentSession) ||
            !ProcessIdToSessionId(pid, out targetSession) ||
            currentSession != targetSession)
            throw new InvalidOperationException("The selected process is unavailable in this Windows session.");

        var handle = OpenProcess(QueryLimitedInformation | Synchronize, false, pid);
        if (handle.IsInvalid)
        {
            handle.Dispose();
            throw new InvalidOperationException("The selected process is unavailable.");
        }
        try
        {
            long started, exited, kernel, user;
            if (!GetProcessTimes(handle, out started, out exited, out kernel, out user))
                throw new InvalidOperationException("Cannot confirm the selected process identity.");
            var creation = (ulong)started;
            if (expected.HasValue && expected.Value != creation)
                throw new InvalidOperationException("The selected process changed. Refresh the app list.");
            var target = new TargetProcess(pid, handle, creation);
            target.EnsureRunning();
            return target;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public void EnsureRunning()
    {
        if (WaitOne(0))
            throw new InvalidOperationException("The selected process has closed. Refresh the app list.");
    }

    public static List<TargetWindow> List()
    {
        var windows = new List<TargetWindow>();
        var pids = new HashSet<uint>();
        var shell = GetShellWindow();
        EnumWindowsProc callback = (window, _) =>
        {
            if (window == shell || !IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero)
                return true;
            int cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) >= 0 && cloaked != 0)
                return true;
            var title = new StringBuilder(257);
            if (GetWindowText(window, title, title.Capacity) == 0) return true;
            var name = title.ToString().Trim();
            if (name.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == 0 || pids.Contains(pid)) return true;
            try
            {
                using (var target = Open(pid))
                {
                    var path = new StringBuilder(32768);
                    int length = path.Capacity;
                    if (!QueryFullProcessImageName(target.SafeWaitHandle, 0, path, ref length)) return true;
                    windows.Add(new TargetWindow
                    {
                        pid = pid,
                        startedAt = target.StartedAt,
                        title = name,
                        appName = Path.GetFileNameWithoutExtension(path.ToString())
                    });
                    pids.Add(pid);
                }
            }
            catch (InvalidOperationException) { }
            return windows.Count < 100;
        };
        if (!EnumWindows(callback, IntPtr.Zero) && windows.Count < 100)
            throw new Win32Exception();
        windows.Sort((left, right) => StringComparer.CurrentCultureIgnoreCase.Compare(left.title, right.title));
        return windows;
    }

    public sealed class TargetWindow
    {
        public uint pid { get; set; }
        public string startedAt { get; set; }
        public string title { get; set; }
        public string appName { get; set; }
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] private static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(SafeWaitHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(SafeWaitHandle process, uint flags, StringBuilder name, ref int size);
}
