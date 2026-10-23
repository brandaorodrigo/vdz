using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace VdzLoopback
{
    internal static class Program
    {
        private const int ActivationProcessLoopback = 1;
        private const int IncludeProcessTree = 0;
        private const ushort WaveFormatPcm = 1;
        private const uint StreamFlags = 0x00020000 | 0x00040000 | 0x80000000;
        private const uint SilentFlag = 0x2;
        private const int FramesPerChunk = 960;
        private const string LoopbackDevice = "VAD\\Process_Loopback";

        private static int Main(string[] args)
        {
            if (args.Length == 0) return 2;
            try
            {
                if (args[0] == "lookup") return Lookup();
                if (args[0] == "capture" && args.Length == 2) return Capture(uint.Parse(args[1]));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
            return 2;
        }

        private static int Lookup()
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                ulong value = ulong.Parse(line);
                IntPtr hwnd = new IntPtr(unchecked((long)value));
                uint pid = 0;
                if (IsWindow(hwnd)) GetWindowThreadProcessId(hwnd, out pid);
                Console.WriteLine(pid);
            }
            return 0;
        }

        private static int Capture(uint pid)
        {
            if (pid == 0) return 2;
            int code = 1;
            var thread = new Thread(() =>
            {
                try
                {
                    int hr = CoInitializeEx(IntPtr.Zero, 0);
                    if (hr < 0) throw new InvalidOperationException("COM 0x" + hr.ToString("X8"));
                    try
                    {
                        Run(pid);
                        code = 0;
                    }
                    finally
                    {
                        CoUninitialize();
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex);
                    code = 1;
                }
            });
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join();
            return code;
        }

        private static void Run(uint pid)
        {
            var handler = new CompletionHandler();
            var activation = new AudioClientActivationParams
            {
                ActivationType = ActivationProcessLoopback,
                TargetProcessId = pid,
                ProcessLoopbackMode = IncludeProcessTree
            };
            int paramSize = Marshal.SizeOf<AudioClientActivationParams>();
            IntPtr paramPtr = Marshal.AllocHGlobal(paramSize);
            IntPtr propVariant = Marshal.AllocHGlobal(32);
            try
            {
                Marshal.StructureToPtr(activation, paramPtr, false);
                for (int i = 0; i < 32; i++) Marshal.WriteByte(propVariant, i, 0);
                Marshal.WriteInt16(propVariant, 0, 65);
                Marshal.WriteInt32(propVariant, 8, paramSize);
                Marshal.WriteIntPtr(propVariant, 16, paramPtr);

                Guid iid = typeof(IAudioClient).GUID;
                int hr = ActivateAudioInterfaceAsync(LoopbackDevice, ref iid, propVariant, handler, out IActivateAudioInterfaceAsyncOperation op);
                if (hr < 0) throw new InvalidOperationException("ativação 0x" + hr.ToString("X8"));
                GC.KeepAlive(op);

                IntPtr[] doneHandles = { handler.Done };
                hr = CoWaitForMultipleHandles(0, 5000, 1, doneHandles, out uint index);
                if (hr < 0 || !handler.DoneSet) throw new InvalidOperationException("espera 0x" + hr.ToString("X8"));
                if (handler.Result < 0 || handler.Client == null)
                    throw new InvalidOperationException("cliente 0x" + handler.Result.ToString("X8"));

                IAudioClient client = handler.Client;
                int sampleRate = OpenClient(client);
                int bufferHr = client.GetBufferSize(out uint bufferFrames);
                if (bufferHr < 0) throw new InvalidOperationException("buffer 0x" + bufferHr.ToString("X8"));
                Guid captureId = typeof(IAudioCaptureClient).GUID;
                int serviceHr = client.GetService(ref captureId, out IntPtr capturePtr);
                if (serviceHr < 0) throw new InvalidOperationException("captura 0x" + serviceHr.ToString("X8"));
                var capture = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(capturePtr);
                Marshal.Release(capturePtr);

                IntPtr sampleEvent = CreateEventW(IntPtr.Zero, false, false, null);
                IntPtr stopEvent = CreateEventW(IntPtr.Zero, true, false, null);
                if (sampleEvent == IntPtr.Zero || stopEvent == IntPtr.Zero)
                    throw new InvalidOperationException("evento");
                try
                {
                    int eventHr = client.SetEventHandle(sampleEvent);
                    if (eventHr < 0) throw new InvalidOperationException("evento 0x" + eventHr.ToString("X8"));
                    int startHr = client.Start();
                    if (startHr < 0) throw new InvalidOperationException("início 0x" + startHr.ToString("X8"));
                    Console.Error.WriteLine("ready");
                    var stdout = Console.OpenStandardOutput();
                    var output = new FloatOutput(stdout, sampleRate);
                    var stdin = new Thread(() =>
                    {
                        try
                        {
                            while (Console.In.Read() >= 0) { }
                        }
                        catch
                        {
                            // O processo principal fechou a entrada.
                        }
                        SetEvent(stopEvent);
                    });
                    stdin.IsBackground = true;
                    stdin.Start();
                    IntPtr[] handles = { stopEvent, sampleEvent };
                    while (true)
                    {
                        uint signaled = WaitForMultipleObjects(2, handles, false, 200);
                        if (signaled == 0) break;
                        Drain(capture, output);
                    }
                    client.Stop();
                    output.FlushPartial();
                }
                finally
                {
                    if (sampleEvent != IntPtr.Zero) CloseHandle(sampleEvent);
                    if (stopEvent != IntPtr.Zero) CloseHandle(stopEvent);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(propVariant);
                Marshal.FreeHGlobal(paramPtr);
                GC.KeepAlive(handler);
            }
        }

        private static int OpenClient(IAudioClient client)
        {
            int[] rates = { 48000, 44100 };
            int last = unchecked((int)0x80004005);
            for (int i = 0; i < rates.Length; i++)
            {
                var format = new WaveFormatEx
                {
                    wFormatTag = WaveFormatPcm,
                    nChannels = 2,
                    nSamplesPerSec = (uint)rates[i],
                    wBitsPerSample = 16,
                    nBlockAlign = 4,
                    nAvgBytesPerSec = (uint)(rates[i] * 4),
                    cbSize = 0
                };
                IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());
                try
                {
                    Marshal.StructureToPtr(format, ptr, false);
                    last = client.Initialize(0, StreamFlags, 0, 0, ptr, IntPtr.Zero);
                    if (last >= 0) return rates[i];
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }
            }
            throw new InvalidOperationException("formato 0x" + last.ToString("X8"));
        }

        private static void Drain(IAudioCaptureClient capture, FloatOutput output)
        {
            while (true)
            {
                int hr = capture.GetNextPacketSize(out uint packet);
                if (hr < 0 || packet == 0) return;
                hr = capture.GetBuffer(out IntPtr data, out uint frames, out uint flags, IntPtr.Zero, IntPtr.Zero);
                if (hr < 0) return;
                output.AddPcm16(data, (int)frames, (flags & SilentFlag) != 0);
                capture.ReleaseBuffer(frames);
            }
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct AudioClientActivationParams
        {
            public int ActivationType;
            public uint TargetProcessId;
            public int ProcessLoopbackMode;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 2)]
        private struct WaveFormatEx
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [ComImport]
        [Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAgileObject
        {
        }

        [ComImport]
        [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IActivateAudioInterfaceCompletionHandler
        {
            void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
        }

        [ComImport]
        [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IActivateAudioInterfaceAsyncOperation
        {
            [PreserveSig]
            int GetActivateResult(out int activateResult, out IntPtr activatedInterface);
        }

        [ComImport]
        [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioClient
        {
            [PreserveSig]
            int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
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
            int GetService(ref Guid riid, out IntPtr instance);
        }

        [ComImport]
        [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioCaptureClient
        {
            [PreserveSig]
            int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, IntPtr devicePosition, IntPtr qpcPosition);
            [PreserveSig]
            int ReleaseBuffer(uint numFramesRead);
            [PreserveSig]
            int GetNextPacketSize(out uint numFrames);
        }

        [ComVisible(true)]
        [ClassInterface(ClassInterfaceType.None)]
        private sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
        {
            public IntPtr Done = CreateEventW(IntPtr.Zero, true, false, null);
            public bool DoneSet;
            public int Result = unchecked((int)0x80004005);
            public IAudioClient Client;

            public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
            {
                try
                {
                    int hr = operation.GetActivateResult(out int activateHr, out IntPtr punk);
                    Result = hr < 0 ? hr : activateHr;
                    if (Result >= 0 && punk != IntPtr.Zero)
                    {
                        Client = (IAudioClient)Marshal.GetObjectForIUnknown(punk);
                        Marshal.Release(punk);
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex.Message);
                    Result = unchecked((int)0x80004005);
                }
                finally
                {
                    DoneSet = true;
                    SetEvent(Done);
                }
            }
        }

        private sealed class FloatOutput
        {
            private readonly Stream stdout;
            private readonly bool direct;
            private readonly double step;
            private readonly List<float> source = new List<float>();
            private readonly float[] chunk = new float[FramesPerChunk * 2];
            private readonly byte[] bytes = new byte[FramesPerChunk * 2 * sizeof(float)];
            private double pos;
            private int filled;

            public FloatOutput(Stream stdout, int sourceRate)
            {
                this.stdout = stdout;
                direct = sourceRate == 48000;
                step = sourceRate / 48000.0;
            }

            public void AddPcm16(IntPtr data, int frames, bool silent)
            {
                for (int i = 0; i < frames; i++)
                {
                    float left = 0;
                    float right = 0;
                    if (!silent)
                    {
                        left = Marshal.ReadInt16(data, i * 4) / 32768f;
                        right = Marshal.ReadInt16(data, i * 4 + 2) / 32768f;
                    }
                    source.Add(left);
                    source.Add(right);
                }
                if (direct)
                {
                    for (int i = 0; i < source.Count; i++) Push(source[i]);
                    source.Clear();
                    return;
                }
                int available = source.Count / 2;
                while (pos + 1 < available)
                {
                    int index = (int)pos;
                    double frac = pos - index;
                    float left = Lerp(source[index * 2], source[(index + 1) * 2], frac);
                    float right = Lerp(source[index * 2 + 1], source[(index + 1) * 2 + 1], frac);
                    Push(left);
                    Push(right);
                    pos += step;
                }
                int drop = (int)pos;
                if (drop > 0)
                {
                    source.RemoveRange(0, drop * 2);
                    pos -= drop;
                }
            }

            public void FlushPartial()
            {
                if (filled == 0) return;
                for (int i = filled; i < chunk.Length; i++) chunk[i] = 0;
                WriteChunk();
            }

            private void Push(float sample)
            {
                chunk[filled++] = sample;
                if (filled == chunk.Length) WriteChunk();
            }

            private void WriteChunk()
            {
                Buffer.BlockCopy(chunk, 0, bytes, 0, bytes.Length);
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
                filled = 0;
            }

            private static float Lerp(float a, float b, double frac)
            {
                return (float)(a + (b - a) * frac);
            }
        }

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();

        [DllImport("ole32.dll")]
        private static extern int CoWaitForMultipleHandles(uint flags, uint timeout, uint count, IntPtr[] handles, out uint index);

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        private static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            ref Guid riid,
            IntPtr activationParams,
            [MarshalAs(UnmanagedType.Interface)] IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hwnd);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll")]
        private static extern bool SetEvent(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    }
}
