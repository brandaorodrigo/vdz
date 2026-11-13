using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[StructLayout(LayoutKind.Sequential)]
struct AudioClientActivationParams
{
    public int ActivationType;
    public uint TargetProcessId;
    public int ProcessLoopbackMode;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
struct PropVariant
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public int cbSize;
    [FieldOffset(16)] public IntPtr pBlob;
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct WaveFormatEx
{
    public short wFormatTag;
    public short nChannels;
    public int nSamplesPerSec;
    public int nAvgBytesPerSec;
    public short nBlockAlign;
    public short wBitsPerSample;
    public short cbSize;
}

[ComImport]
[Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    [PreserveSig]
    int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport]
[Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    [PreserveSig]
    int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
}

[ComImport]
[Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig]
    int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSession);
    [PreserveSig]
    int GetBufferSize(out uint numBufferFrames);
    [PreserveSig]
    int GetStreamLatency(out long latency);
    [PreserveSig]
    int GetCurrentPadding(out uint numPaddingFrames);
    [PreserveSig]
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig]
    int GetMixFormat(out IntPtr deviceFormat);
    [PreserveSig]
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig]
    int Start();
    [PreserveSig]
    int Stop();
    [PreserveSig]
    int Reset();
    [PreserveSig]
    int SetEventHandle(IntPtr eventHandle);
    [PreserveSig]
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport]
[Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig]
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig]
    int ReleaseBuffer(uint frames);
    [PreserveSig]
    int GetNextPacketSize(out uint frames);
}

[ComVisible(true)]
sealed class Completion : IActivateAudioInterfaceCompletionHandler, ICustomQueryInterface
{
    static readonly Guid Agile = new Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90");
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public IAudioClient Client;
    public int Hr = unchecked((int)0x80004005);

    public CustomQueryInterfaceResult GetInterface(ref Guid iid, out IntPtr ppv)
    {
        if (iid == Agile)
        {
            ppv = Marshal.GetComInterfaceForObject(this, typeof(IActivateAudioInterfaceCompletionHandler));
            return CustomQueryInterfaceResult.Handled;
        }
        ppv = IntPtr.Zero;
        return CustomQueryInterfaceResult.NotHandled;
    }

    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        try
        {
            object activated;
            int activate;
            int get = operation.GetActivateResult(out activate, out activated);
            Hr = get < 0 ? get : activate;
            if (Hr >= 0)
            {
                Client = (IAudioClient)activated;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            Hr = unchecked((int)0x80004005);
        }
        Done.Set();
        return 0;
    }
}

static class Audio
{
    const int ProcessLoopback = 1;
    const int IncludeTree = 0;
    const uint Loopback = 0x00020000;
    const uint EventCallback = 0x00040000;
    const uint AutoConvert = 0x80000000;
    const int Silent = 0x2;

    [DllImport("mmdevapi.dll", ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr hwnd, EnumProc proc, IntPtr param);

    static int Fail(string step, int hr)
    {
        Console.Error.WriteLine(step + " 0x" + hr.ToString("X8"));
        return 1;
    }

    static uint PidFromWindow(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0)
        {
            return 0;
        }
        string name = "";
        try
        {
            name = Process.GetProcessById((int)pid).ProcessName;
        }
        catch
        {
            return pid;
        }
        if (!name.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
        {
            return pid;
        }
        uint found = pid;
        EnumChildWindows(hwnd, (child, param) =>
        {
            uint childPid;
            GetWindowThreadProcessId(child, out childPid);
            if (childPid != 0 && childPid != pid)
            {
                found = childPid;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static int PrintPids(string[] args)
    {
        for (int i = 1; i < args.Length; i++)
        {
            long value;
            if (!long.TryParse(args[i], out value))
            {
                continue;
            }
            uint pid = PidFromWindow(new IntPtr(value));
            Console.WriteLine(value + " " + pid);
        }
        return 0;
    }

    [MTAThread]
    static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("hwnd");
            return 1;
        }
        if (args[0] == "--pid")
        {
            return PrintPids(args);
        }

        long hwndValue;
        uint pid;
        if (args[0] == "--self")
        {
            pid = (uint)Process.GetCurrentProcess().Id;
        }
        else if (!long.TryParse(args[0], out hwndValue))
        {
            Console.Error.WriteLine("hwnd");
            return 1;
        }
        else
        {
            pid = PidFromWindow(new IntPtr(hwndValue));
        }
        if (pid == 0)
        {
            return Fail("pid", unchecked((int)0x80070057));
        }

        var activation = new AudioClientActivationParams
        {
            ActivationType = ProcessLoopback,
            TargetProcessId = pid,
            ProcessLoopbackMode = IncludeTree,
        };
        int activationSize = Marshal.SizeOf(typeof(AudioClientActivationParams));
        IntPtr blob = Marshal.AllocHGlobal(activationSize);
        Marshal.StructureToPtr(activation, blob, false);
        var prop = new PropVariant { vt = 65, cbSize = activationSize, pBlob = blob };
        IntPtr propPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PropVariant)));
        Marshal.StructureToPtr(prop, propPtr, false);

        var clientId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        var done = new Completion();
        IActivateAudioInterfaceAsyncOperation op;
        int hr = ActivateAudioInterfaceAsync(@"VAD\Process_Loopback", ref clientId, propPtr, done, out op);
        if (hr < 0)
        {
            return Fail("ativar", hr);
        }
        if (!done.Done.WaitOne(5000) || done.Hr < 0 || done.Client == null)
        {
            return Fail("ativar", done.Hr);
        }

        var format = new WaveFormatEx
        {
            wFormatTag = 1,
            nChannels = 2,
            nSamplesPerSec = 48000,
            wBitsPerSample = 16,
            nBlockAlign = 4,
            nAvgBytesPerSec = 48000 * 4,
            cbSize = 0,
        };
        IntPtr formatPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatEx)));
        Marshal.StructureToPtr(format, formatPtr, false);
        hr = done.Client.Initialize(0, Loopback | EventCallback | AutoConvert, 0, 0, formatPtr, IntPtr.Zero);
        if (hr < 0)
        {
            return Fail("iniciar", hr);
        }

        var ready = new EventWaitHandle(false, EventResetMode.AutoReset);
        hr = done.Client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        if (hr < 0)
        {
            return Fail("evento", hr);
        }

        var captureId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object service;
        hr = done.Client.GetService(ref captureId, out service);
        if (hr < 0)
        {
            return Fail("captura", hr);
        }
        var capture = (IAudioCaptureClient)service;
        hr = done.Client.Start();
        if (hr < 0)
        {
            return Fail("start", hr);
        }

        Stream stdout = Console.OpenStandardOutput();
        stdout.Write(BitConverter.GetBytes(format.nSamplesPerSec), 0, 4);
        stdout.Write(BitConverter.GetBytes(format.nChannels), 0, 2);
        stdout.Write(BitConverter.GetBytes(format.wBitsPerSample), 0, 2);
        stdout.Flush();

        try
        {
            while (true)
            {
                ready.WaitOne(200);
                uint frames;
                while (capture.GetNextPacketSize(out frames) >= 0 && frames > 0)
                {
                    IntPtr data;
                    uint flags;
                    ulong dev;
                    ulong qpc;
                    hr = capture.GetBuffer(out data, out frames, out flags, out dev, out qpc);
                    if (hr < 0)
                    {
                        return Fail("buffer", hr);
                    }
                    int bytes = (int)frames * format.nBlockAlign;
                    byte[] copy = new byte[bytes];
                    if ((flags & Silent) == 0 && data != IntPtr.Zero && bytes > 0)
                    {
                        Marshal.Copy(data, copy, 0, bytes);
                    }
                    capture.ReleaseBuffer(frames);
                    stdout.Write(copy, 0, copy.Length);
                    stdout.Flush();
                }
            }
        }
        catch (IOException)
        {
            return 0;
        }
    }
}
