// Process activation and capture flow adapted from Microsoft's Application
// Loopback API Capture Sample (MIT). See LICENSE-Microsoft.txt.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Wasapi
{
    private const string VirtualProcessLoopback = "VAD\\Process_Loopback";
    private const uint StreamLoopback = 0x00020000;
    private const uint StreamEventCallback = 0x00040000;
    private const uint StreamUseDefaultQuality = 0x08000000;
    private const uint StreamAutoConvertPcm = 0x80000000;
    private const uint BufferSilent = 0x00000002;
    private const int PcmSampleRate = 16000;
    private const int PcmBlockAlign = 2;

    public static void Capture(TargetProcess target, ManualResetEvent stop, Stream output)
    {
        Check(CoInitializeEx(IntPtr.Zero, 0), "COM initialization");
        try
        {
            var client = Activate(target, stop);
            if (client == null) return;
            try { CaptureAudio(client, target, stop, output); }
            finally { Marshal.ReleaseComObject(client); }
        }
        finally { CoUninitialize(); }
    }

    private static IAudioClient Activate(TargetProcess target, ManualResetEvent stop)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS contains three UINT32s for process
        // loopback. Its PROPVARIANT uses a BLOB (VT_BLOB) on x64.
        var payload = Marshal.AllocCoTaskMem(12);
        Marshal.WriteInt32(payload, 0, 1);
        Marshal.WriteInt32(payload, 4, unchecked((int)target.Id));
        Marshal.WriteInt32(payload, 8, 0); // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        var variant = new ActivationVariant { Type = 65, ByteCount = 12, Payload = payload };
        var audioId = typeof(IAudioClient).GUID;
        var completion = new ActivationCompletion();
        IActivationOperation operation = null;
        var callbackCompleted = false;
        try
        {
            Check(ActivateAudioInterfaceAsync(VirtualProcessLoopback, ref audioId, ref variant, completion, out operation), "process audio activation");
            var result = WaitHandle.WaitAny(new WaitHandle[] { stop, target, completion.Completed }, 8000);
            if (result == 0) return null;
            if (result == 1) target.EnsureRunning();
            if (result == WaitHandle.WaitTimeout) throw new TimeoutException("Process audio activation timed out.");
            callbackCompleted = true;
            Check(completion.Result, "process audio activation");
            if (completion.Interface == IntPtr.Zero) throw new InvalidOperationException("Windows returned no audio client.");
            return (IAudioClient)Marshal.GetObjectForIUnknown(completion.Interface);
        }
        finally
        {
            // A cancelled activation may still be completing on a Windows thread.
            // This executable exits in that case, so retain its arguments until exit.
            if (callbackCompleted || operation == null)
            {
                if (completion.Interface != IntPtr.Zero) Marshal.Release(completion.Interface);
                completion.Completed.Dispose();
                Marshal.FreeCoTaskMem(payload);
            }
            GC.KeepAlive(operation);
            GC.KeepAlive(completion);
        }
    }

    private static void CaptureAudio(IAudioClient client, TargetProcess target, ManualResetEvent stop, Stream output)
    {
        using (var ready = new AutoResetEvent(false))
        {
            var format = new WaveFormat
            {
                Tag = 1, Channels = 1, SamplesPerSecond = PcmSampleRate, Bits = 16,
                BlockAlign = PcmBlockAlign, BytesPerSecond = PcmSampleRate * PcmBlockAlign
            };
            Check(client.Initialize(0, StreamLoopback | StreamEventCallback | StreamAutoConvertPcm | StreamUseDefaultQuality,
                0, 0, ref format, IntPtr.Zero), "PCM format initialization");
            uint bufferFrames;
            Check(client.GetBufferSize(out bufferFrames), "capture buffer sizing");
            if (bufferFrames == 0 || bufferFrames > PcmSampleRate * 2)
                throw new InvalidOperationException("Windows reported an invalid capture buffer size.");
            var buffer = new byte[bufferFrames * PcmBlockAlign];
            var service = typeof(IAudioCaptureClient).GUID;
            object stream;
            Check(client.GetService(ref service, out stream), "capture service initialization");
            try
            {
                var capture = (IAudioCaptureClient)stream;
                Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()), "capture event setup");
                if (stop.WaitOne(0)) return;
                target.EnsureRunning();
                Check(client.Start(), "audio stream start");
                try
                {
                    target.EnsureRunning();
                    Console.Error.WriteLine("READY");
                    Console.Error.Flush();
                    var handles = new WaitHandle[] { stop, target, ready };
                    for (;;)
                    {
                        var signalled = WaitHandle.WaitAny(handles);
                        if (signalled == 0) break;
                        if (signalled == 1) target.EnsureRunning();
                        Drain(capture, buffer, output, stop);
                    }
                    output.Flush();
                }
                finally { client.Stop(); }
            }
            finally { Marshal.ReleaseComObject(stream); }
        }
    }

    private static void Drain(IAudioCaptureClient capture, byte[] buffer, Stream output, ManualResetEvent stop)
    {
        while (!stop.WaitOne(0))
        {
            uint packet;
            Check(capture.GetNextPacketSize(out packet), "audio packet query");
            if (packet == 0) return;
            IntPtr data;
            uint frames, flags;
            ulong position, time;
            Check(capture.GetBuffer(out data, out frames, out flags, out position, out time), "audio packet capture");
            var length = checked((int)frames * PcmBlockAlign);
            try
            {
                if (length > buffer.Length) throw new InvalidOperationException("The capture packet exceeded the Windows buffer.");
                if ((flags & BufferSilent) != 0) Array.Clear(buffer, 0, length);
                else if (length > 0) Marshal.Copy(data, buffer, 0, length);
            }
            finally { Check(capture.ReleaseBuffer(frames), "audio packet release"); }
            if (length > 0) output.Write(buffer, 0, length);
        }
    }

    private static void Check(int result, string operation)
    {
        if (result < 0) throw new InvalidOperationException("Windows " + operation + " failed (0x" + result.ToString("X8") + ").");
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct ActivationVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public uint ByteCount;
        [FieldOffset(16)] public IntPtr Payload;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint SamplesPerSecond, BytesPerSecond;
        public ushort BlockAlign, Bits;
        public ushort ExtraSize;
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ActivationCompletion : IActivationCompletion, IAgileObject
    {
        public readonly ManualResetEvent Completed = new ManualResetEvent(false);
        public IntPtr Interface;
        public int Result;

        public int ActivateCompleted(IActivationOperation operation)
        {
            try
            {
                int activated;
                var result = operation.GetActivateResult(out activated, out Interface);
                Result = result < 0 ? result : activated;
            }
            catch (Exception error) { Result = Marshal.GetHRForException(error); }
            finally { Completed.Set(); }
            return 0;
        }
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationCompletion
    {
        [PreserveSig] int ActivateCompleted(IActivationOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationOperation
    {
        [PreserveSig] int GetActivateResult(out int result, out IntPtr activatedInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, uint flags, long bufferDuration, long periodicity, ref WaveFormat format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("mmdevapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int ActivateAudioInterfaceAsync(string device, ref Guid interfaceId, ref ActivationVariant parameters,
        IActivationCompletion completion, out IActivationOperation operation);
}
