// ── Bass Boost: the PowerShell/C# audio host ─────────────────────────────────
//
// One long-lived helper process that IS the equaliser. Split out of
// main/bassBoost.js purely for size; that module is the only consumer, and
// test/bass-boost.test.js compiles this script and drives its protocol.
//
// HOW SPOTIFY GETS BOOSTED WITHOUT A DRIVER (each step verified live on
// Windows 11 before this was written):
//
//   1. PROCESS LOOPBACK (Windows 10 2004+). ActivateAudioInterfaceAsync on
//      "VAD\Process_Loopback" hands us a capture client fed with ONLY the audio
//      of Spotify's process tree — nothing else on the PC.
//   2. That capture is taken AFTER Spotify's session volume and mute: muting
//      Spotify in the mixer silences the capture too (measured 0.13 -> 0.00
//      RMS), so we can't simply mute the original. But it is taken BEFORE the
//      endpoint: muting the DEVICE Spotify plays on leaves the capture at full
//      level (measured 0.21 -> 0.22).
//   3. So Spotify is ROUTED to a spare output (per-app default device, the same
//      undocumented AudioPolicyConfig factory Windows' own "App volume and
//      device preferences" page and EarTrumpet use) and that spare output is
//      MUTED. Spotify keeps playing — silently — and we hear only our copy.
//   4. Our copy runs through the EQ and is rendered to the real speakers in
//      shared mode at 48 kHz float. Total added delay is ~40 ms: one 10 ms
//      capture packet, a 20 ms render cushion and the device's own buffer.
//      Measured: packets arrive on a rock-steady 10 ms clock, but a 10 ms
//      cushion still starves once at start and settles at 20 ms by itself,
//      so 20 ms is the floor on shared-mode WASAPI here. Nothing in Spotify's
//      own controls changes — its volume slider still sets the level we capture.
//
// Everything this changes on the system (Spotify's route, the spare output's
// mute) is written to a RESTORE FILE before it is changed and put back on
// STOP, on EXIT, when stdin closes (main died) and — if the process was killed
// outright — the next time the host starts. A per-app route can only be reset
// while Spotify is running (the API takes a process id), so a reset that comes
// due while Spotify is closed stays "pending" until it next appears.
//
// ── Protocol ────────────────────────────────────────────────────────────────
// IN (one per line):
//   START <targetId|-> <sinkId|->   run: '-' target = the Windows default
//                                    output, '-' sink = pick a spare output
//   STOP                             stop and restore everything
//   CHAIN <bypass> <pre> <out> <ceil> <relMs> <harm> <lp×5> <hp×5> <xoLp×5> <xoHp×5>
//         <bassCeil> <bassAtkMs> <bassRelMs> <n> <bq×5n>
//                                    the DSP chain (built by renderer/
//                                    bass-engine.js); takes effect next packet
//   METER <0|1>                      stream spectrum frames
//   FORCECAP <n|-1>                  test hook: use only capture variant n
//   CAPTEST                          try every capture variant against Spotify
//                                    (no routing); prints CAPTEST lines
//   DEVICES                          list the active outputs
//   TESTDSP <hz>                     run a sine through the chain, print gain
//   TESTMIX <loHz> <loAmp> <hiHz> <hiAmp>
//                                    two sines at once; prints each one's gain
//                                    (proves a loud bass note doesn't duck mids)
//   EXIT                             restore and quit
// OUT:
//   READY
//   STATUS {json}                    state + device names + pending flag
//   DEVICES [json]
//   CHAIN-OK <n>
//   RATE <hz>                        the pipeline runs at this rate now (a
//                                    44.1 kHz capture fallback was needed);
//                                    main rebuilds the chain for it
//   LV <hex> <gr> <peak> <lat> <bgr> 32 spectrum bands (0-255), final-limiter
//                                    gain reduction (0-255 = 0..-24 dB), output
//                                    peak, latency ms, bass-limiter reduction
//   TESTDSP <hz> <gainDb>
//   LOG <text>
//
// Bump BASS_HOST_SCRIPT_VERSION on any change to the script body: the cached
// .ps1 is only rewritten on a version change (scriptCache.ensureVersionedScript).
const BASS_HOST_SCRIPT_VERSION = 5;

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace MainBassBoost {

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorCo { }

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PKEY key);
    [PreserveSig] int GetValue(ref PKEY key, IntPtr propVariant);
}
[StructLayout(LayoutKind.Sequential)] public struct PKEY { public Guid fmtid; public int pid; }

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioRenderClient {
    [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
    [PreserveSig] int ReleaseBuffer(uint frames, uint flags);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
    [PreserveSig] int GetChannelCount(out uint c);
    [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float v, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float db);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float v);
    [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float v, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float v);
    [PreserveSig] int SetMute(int mute, ref Guid ctx);
    [PreserveSig] int GetMute(out int mute);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation {
    [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler {
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
}

// The completion handler MUST be agile or activation fails; an empty
// IAgileObject is how a .NET object declares that.
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }

[ClassInterface(ClassInterfaceType.None)]
public class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public int Hr = -1;
    public object Result;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
        try { int hr; object o; op.GetActivateResult(out hr, out o); Hr = hr; Result = o; }
        catch (Exception) { Hr = -1; }
        Done.Set();
        return 0;
    }
}

public sealed class Chain {
    public static readonly double[] Identity = new double[] { 1, 0, 0, 0, 0 };
    public bool Bypass;
    public double Pre = 1, Out = 1, Ceil = 0.944, RelCoef = 0.0005, Harm = 0;
    public double[] HarmLp = Identity, HarmHp = Identity, XoLp = Identity, XoHp = Identity;
    public double BassCeil = 2.0, BassAtk = 0.005, BassRel = 0.0002;
    public double[][] Bq = new double[0][];
}

public sealed class Dev { public string Id; public string Name; public bool IsDefault; }

public static class Host {
    static int RATE = 48000;
    const int METER_N = 2048;
    const int BANDS = 32;
    const uint LOOPBACK = 0x00020000, EVENTCB = 0x00040000, AUTOCONVERT = 0x80000000, SRCDEFAULT = 0x08000000;

    static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static Guid IID_Capture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static Guid IID_Render = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
    static Guid IID_EpVol = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static Guid IID_Policy = new Guid("ab3d4648-e242-459f-b02f-541c70306324");

    [DllImport("Mmdevapi.dll", ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr parms, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr cls, ref Guid iid, out IntPtr factory);
    [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int len, out IntPtr h);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr h);
    [DllImport("combase.dll")] static extern IntPtr WindowsGetStringRawBuffer(IntPtr h, out uint len);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetPersistedFn(IntPtr self, uint pid, int flow, int role, IntPtr hDev);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetPersistedFn(IntPtr self, uint pid, int flow, int role, out IntPtr hDev);

    // ── plumbing ──
    static StreamWriter stdout;
    static readonly BlockingCollection<string> outQ = new BlockingCollection<string>(512);
    static readonly ConcurrentQueue<string> cmdQ = new ConcurrentQueue<string>();
    static readonly AutoResetEvent cmdEvent = new AutoResetEvent(false);
    static volatile Chain chain = new Chain();
    static volatile bool meterOn = false;
    static bool exiting = false;
    static string restorePath;

    // ── wanted state ──
    static bool wantActive = false;
    static string targetPref = "-", sinkPref = "-";

    // ── stream ──
    static IAudioClient capClient, renClient;
    static IAudioCaptureClient capSvc;
    static IAudioRenderClient renSvc;
    static AutoResetEvent capEvent;
    static uint curPid = 0, renFrames = 0;
    static string curTarget = null;
    static bool streamLost = false;

    // ── route (the system changes we must undo) ──
    static string routeSink = null;      // the spare output Spotify is routed to
    static string routePrev = null;      // Spotify's route before us (null = default)
    static bool routeApplied = false;    // Spotify's route still needs putting back
    static bool sinkMuteApplied = false; // the spare output's mute still needs putting back
    static int sinkPrevMute = 0;
    static uint routedPid = 0;

    static string lastStatus = "";
    static long errorUntil = 0;
    static readonly Stopwatch clock = Stopwatch.StartNew();

    const string MUTEX = "Local\\MainBassBoostHost";
    static Mutex alive;

    public static void Run(string restoreFile, string scriptPath) {
        restorePath = restoreFile;
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        // Held for this host's whole life: a watchdog left over from a
        // previous host stands down the moment it sees a new one.
        try { alive = new Mutex(false, MUTEX); } catch (Exception) { }
        StartWatchdog(scriptPath);
        Thread writer = new Thread(WriterLoop); writer.IsBackground = true; writer.Start();
        Thread audio = new Thread(AudioLoop);
        audio.SetApartmentState(ApartmentState.MTA);
        audio.Priority = ThreadPriority.Highest;
        audio.Start();
        StreamReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        while (true) {
            string line = null;
            try { line = stdin.ReadLine(); } catch (Exception) { line = null; }
            if (line == null) { Enqueue("EXIT"); break; }   // main went away: restore and quit
            line = line.Trim();
            if (line.Length == 0) continue;
            Enqueue(line);
            if (line == "EXIT") break;
        }
        audio.Join(8000);
        outQ.CompleteAdding();
        writer.Join(1000);
    }

    static void Enqueue(string s) { cmdQ.Enqueue(s); cmdEvent.Set(); }

    // ── Watchdog ──
    // Electron puts its children in a kill-on-close job: when main quits or
    // crashes, this host is killed on the spot and never gets to put Spotify's
    // output back. Processes WE start break away from that job silently, so
    // the host starts a tiny watchdog (this same script, -WatchPid) that waits
    // for the host to die and then does the restore itself.
    static void StartWatchdog(string scriptPath) {
        if (string.IsNullOrEmpty(scriptPath) || restorePath == null) return;
        try {
            ProcessStartInfo si = new ProcessStartInfo("powershell.exe",
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\" -RestoreFile \"" + restorePath +
                "\" -WatchPid " + System.Diagnostics.Process.GetCurrentProcess().Id);
            si.UseShellExecute = false;
            si.CreateNoWindow = true;
            si.WindowStyle = ProcessWindowStyle.Hidden;
            System.Diagnostics.Process.Start(si);
        } catch (Exception e) { Log("watchdog didn't start: " + e.Message); }
    }

    public static void Watch(string restoreFile, int pid) {
        restorePath = restoreFile;
        try {
            System.Diagnostics.Process host = System.Diagnostics.Process.GetProcessById(pid);
            host.WaitForExit();
        } catch (Exception) { /* already gone */ }
        Thread t = new Thread(WatchLoop);
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
        t.Join();
    }

    static void WatchLoop() {
        // Give a clean exit a moment to finish its own restore.
        Thread.Sleep(1500);
        for (int i = 0; ; i++) {
            Mutex m;
            if (Mutex.TryOpenExisting(MUTEX, out m)) { m.Dispose(); return; }   // a new host took over
            if (!File.Exists(restorePath) && !File.Exists(LedgerPath())) return;  // nothing left to undo
            try { RestoreFromFile(); } catch (Exception) { }
            try { SweepLedger(); } catch (Exception) { }
            if (!File.Exists(restorePath) && !File.Exists(LedgerPath())) return;
            Thread.Sleep(i < 30 ? 2000 : 10000);   // pending: wait for Spotify to reopen
        }
    }

    static void WriterLoop() {
        try { foreach (string s in outQ.GetConsumingEnumerable()) { try { stdout.WriteLine(s); } catch (Exception) { } } }
        catch (Exception) { }
    }

    static void Emit(string s) { try { outQ.TryAdd(s, 200); } catch (Exception) { } }
    static void Log(string s) { Emit("LOG " + s.Replace("\r", " ").Replace("\n", " ")); }

    static string J(string s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
            else if (c < 32) b.Append(' ');
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static void Status(string state, string message) {
        string tn = null, sn = null;
        try { if (curTarget != null) tn = NameOf(curTarget); } catch (Exception) { }
        try { if (routeSink != null) sn = NameOf(routeSink); } catch (Exception) { }
        bool pending = routeApplied && wantActive == false;
        string s = "STATUS {\"state\":" + J(state) + ",\"message\":" + J(message) + ",\"target\":" + J(tn) +
                   ",\"sink\":" + J(sn) + ",\"pending\":" + (pending ? "true" : "false") + "}";
        if (s == lastStatus) return;
        lastStatus = s;
        Emit(s);
    }

    // ── main audio thread ──
    static void AudioLoop() {
        try { RestoreFromFile(); } catch (Exception e) { Log("restore failed: " + e.Message); }
        try { SweepLedger(); } catch (Exception e) { Log("mute sweep failed: " + e.Message); }
        Emit("READY");
        Status("off", "");
        long nextTick = 0;
        WaitHandle[] waits = new WaitHandle[2];
        while (!exiting) {
            string cmd;
            while (cmdQ.TryDequeue(out cmd)) { try { Handle(cmd); } catch (Exception e) { Log("command failed: " + e.Message); } }
            if (exiting) break;
            long now = clock.ElapsedMilliseconds;
            if (now >= nextTick) {
                try { Tick(); } catch (Exception e) { Log("tick failed: " + e.Message); }
                nextTick = now + 1000;
            }
            if (capSvc != null && !streamLost) {
                if (capEvent != null) { waits[0] = capEvent; waits[1] = cmdEvent; WaitHandle.WaitAny(waits, 15); }
                else cmdEvent.WaitOne(5);       // timer-driven capture variant
                try { Pump(); } catch (Exception e) { streamLost = true; Log("stream error: " + e.Message); }
            } else {
                cmdEvent.WaitOne(250);
            }
        }
        try { StopStream(); } catch (Exception) { }
        try { UndoRoute(); } catch (Exception) { }
    }

    static void Handle(string cmd) {
        string[] t = cmd.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        string op = t[0];
        if (op == "EXIT") { exiting = true; return; }
        if (op == "START") {
            wantActive = true;
            targetPref = t.Length > 1 ? t[1] : "-";
            sinkPref = t.Length > 2 ? t[2] : "-";
            errorUntil = 0;
            Tick();
            return;
        }
        if (op == "STOP") {
            wantActive = false;
            StopStream();
            UndoRoute();
            curTarget = null;
            Status(routeApplied ? "off" : "off", "");
            return;
        }
        if (op == "METER") { meterOn = t.Length > 1 && t[1] == "1"; return; }
        if (op == "CAPTEST") { CapTest(); return; }
        if (op == "FORCECAP") { forceCap = t.Length > 1 ? int.Parse(t[1], CultureInfo.InvariantCulture) : -1; streamLost = true; return; }
        if (op == "DEVICES") { Emit("DEVICES " + DevicesJson()); return; }
        if (op == "CHAIN") { ParseChain(t); return; }
        if (op == "TESTDSP") { TestDsp(t.Length > 1 ? D(t[1]) : 60); return; }
        if (op == "TESTMIX" && t.Length >= 5) { TestMix(D(t[1]), D(t[2]), D(t[3]), D(t[4])); return; }
        Log("unknown command " + op);
    }

    static double D(string s) { return double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture); }

    static void ParseChain(string[] t) {
        // CHAIN bypass pre out ceil relMs harm lp0..4 hp0..4 n bq...
        Chain c = new Chain();
        int i = 1;
        c.Bypass = t[i++] == "1";
        c.Pre = D(t[i++]); c.Out = D(t[i++]); c.Ceil = D(t[i++]);
        double rel = Math.Max(1, D(t[i++]));
        c.RelCoef = 1 - Math.Exp(-1.0 / (rel * 0.001 * RATE));
        c.Harm = D(t[i++]);
        c.HarmLp = new double[5]; for (int k = 0; k < 5; k++) c.HarmLp[k] = D(t[i++]);
        c.HarmHp = new double[5]; for (int k = 0; k < 5; k++) c.HarmHp[k] = D(t[i++]);
        c.XoLp = new double[5]; for (int k = 0; k < 5; k++) c.XoLp[k] = D(t[i++]);
        c.XoHp = new double[5]; for (int k = 0; k < 5; k++) c.XoHp[k] = D(t[i++]);
        c.BassCeil = D(t[i++]);
        c.BassAtk = 1 - Math.Exp(-1.0 / (Math.Max(0.1, D(t[i++])) * 0.001 * RATE));
        c.BassRel = 1 - Math.Exp(-1.0 / (Math.Max(1, D(t[i++])) * 0.001 * RATE));
        if (!(c.BassCeil > 0.01)) c.BassCeil = 0.5;
        int n = int.Parse(t[i++], CultureInfo.InvariantCulture);
        if (n < 0 || n > 64) throw new Exception("bad biquad count");
        c.Bq = new double[n][];
        for (int b = 0; b < n; b++) { c.Bq[b] = new double[5]; for (int k = 0; k < 5; k++) c.Bq[b][k] = D(t[i++]); }
        foreach (double[] q in c.Bq) foreach (double v in q) if (double.IsNaN(v) || double.IsInfinity(v)) throw new Exception("bad coefficient");
        if (!(c.Ceil > 0.01 && c.Ceil <= 1)) c.Ceil = 0.944;
        chain = c;
        Emit("CHAIN-OK " + n);
    }

    // ── supervision: runs once a second and on START ──
    static void Tick() {
        if (!wantActive) {
            if (routeApplied) TryFinishPendingRoute();
            return;
        }
        if (clock.ElapsedMilliseconds < errorUntil) return;

        uint pid = SpotifyRoot();
        List<Dev> devs = ActiveOutputs();
        string target = null;
        foreach (Dev d in devs) if (targetPref != "-" && d.Id == targetPref) target = d.Id;
        if (target == null) foreach (Dev d in devs) if (d.IsDefault) target = d.Id;
        if (target == null) { StopStream(); UndoRoute(); Status("error", "No speakers are connected"); return; }
        string sink = PickSink(devs, target);
        if (sink == null) {
            StopStream(); UndoRoute(); curTarget = target;
            Status("nosink", "Only one audio output is connected — Bass Boost plays on one and hides Spotify's own sound on another. Check your speakers are plugged in");
            return;
        }
        if (routeSink != null && routeSink != sink) UndoRoute();

        if (pid == 0) {
            StopStream();
            curTarget = target;
            Status("waiting", "Waiting for Spotify");
            return;
        }

        bool restart = capSvc == null || streamLost || pid != curPid || target != curTarget;
        if (restart) {
            StopStream();
            try { StartStream(pid, target); }
            catch (Exception e) {
                StopStream(); UndoRoute();
                Log("start failed: " + e.Message);
                Status("error", e.Message);
                errorUntil = clock.ElapsedMilliseconds + 5000;
                return;
            }
        }
        try { ApplyRoute(pid, sink, target); }
        catch (Exception e) {
            StopStream(); UndoRoute();
            Log("route failed: " + e.Message);
            Status("error", e.Message);
            errorUntil = clock.ElapsedMilliseconds + 5000;
            return;
        }
        Status("active", "");
    }

    static string PickSink(List<Dev> devs, string target) {
        if (sinkPref != "-") { foreach (Dev d in devs) if (d.Id == sinkPref && d.Id != target) return d.Id; }
        string tName = null;
        foreach (Dev d in devs) if (d.Id == target) tName = d.Name;
        string card = Card(tName);
        // Same sound card first (usually the laptop's own speakers beside a
        // headphone jack), then anything called Speakers, then anything at all.
        foreach (Dev d in devs) if (d.Id != target && card != null && Card(d.Name) == card) return d.Id;
        foreach (Dev d in devs) if (d.Id != target && d.Name != null && d.Name.StartsWith("Speakers")) return d.Id;
        foreach (Dev d in devs) if (d.Id != target) return d.Id;
        return null;
    }

    static string Card(string name) {
        if (name == null) return null;
        int a = name.IndexOf('(');
        if (a < 0) return null;
        return name.Substring(a);
    }

    // ── stream ──
    static IntPtr MakeFormat(int rate, bool pcm16) {
        IntPtr f = Marshal.AllocCoTaskMem(18);
        int block = pcm16 ? 4 : 8;
        Marshal.WriteInt16(f, 0, (short)(pcm16 ? 1 : 3));   // WAVE_FORMAT_PCM / _IEEE_FLOAT
        Marshal.WriteInt16(f, 2, 2);
        Marshal.WriteInt32(f, 4, rate);
        Marshal.WriteInt32(f, 8, rate * block);
        Marshal.WriteInt16(f, 12, (short)block);
        Marshal.WriteInt16(f, 14, (short)(pcm16 ? 16 : 32));
        Marshal.WriteInt16(f, 16, 0);
        return f;
    }

    // ── capture ladder ──
    // Process-loopback capture is fussier on some Windows builds than on
    // others: a format or flag one build accepts, another rejects at
    // Initialize ("Listening to Spotify failed"). So capture is opened by
    // trying these in order, most capable first, ending with Microsoft's own
    // ApplicationLoopback sample settings (16-bit, 44.1 kHz, event-driven) and
    // finally a timer-driven variant that needs no audio event at all. The one
    // that works is remembered for next time; every failure is logged with
    // its stage and code.
    sealed class CapVariant {
        public readonly string Name; public readonly int Rate; public readonly bool Pcm16; public readonly uint Flags; public readonly bool Event;
        public CapVariant(string name, int rate, bool pcm16, uint flags, bool ev) { Name = name; Rate = rate; Pcm16 = pcm16; Flags = flags; Event = ev; }
    }
    static readonly CapVariant[] CAP_VARIANTS = new CapVariant[] {
        new CapVariant("float 48k + SRC", 48000, false, LOOPBACK | EVENTCB | AUTOCONVERT | SRCDEFAULT, true),
        new CapVariant("float 48k", 48000, false, LOOPBACK | EVENTCB | AUTOCONVERT, true),
        new CapVariant("pcm16 48k", 48000, true, LOOPBACK | EVENTCB | AUTOCONVERT, true),
        new CapVariant("pcm16 44.1k (Microsoft sample)", 44100, true, LOOPBACK | EVENTCB | AUTOCONVERT, true),
        new CapVariant("float 48k, timer-driven", 48000, false, LOOPBACK | AUTOCONVERT, false),
        new CapVariant("pcm16 44.1k, timer-driven", 44100, true, LOOPBACK | AUTOCONVERT, false)
    };
    static int lastGoodCap = 0;
    static int forceCap = -1;          // test hook (FORCECAP n)
    static bool capPcm16 = false;
    static short[] sbuf = new short[4096];
    static string capName = "";

    // One attempt: a FRESH client per try (a client whose Initialize failed is
    // not reliably reusable). Returns null on success, else "stage (0x...)".
    static string TryCapture(uint pid, CapVariant v) {
        int ahr;
        IAudioClient c = ActivateLoopback(pid, out ahr);
        if (c == null) return "activate (0x" + ahr.ToString("X8") + ")";
        IntPtr fmt = MakeFormat(v.Rate, v.Pcm16);
        AutoResetEvent ev = null;
        try {
            int hr = c.Initialize(0, v.Flags, 200000, 0, fmt, IntPtr.Zero);
            if (hr < 0) { Release(c); return "Initialize (0x" + hr.ToString("X8") + ")"; }
            if (v.Event) {
                ev = new AutoResetEvent(false);
                hr = c.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
                if (hr < 0) { ev.Close(); Release(c); return "SetEventHandle (0x" + hr.ToString("X8") + ")"; }
            }
            object o; Guid iid = IID_Capture;
            hr = c.GetService(ref iid, out o);
            if (hr < 0) { if (ev != null) ev.Close(); Release(c); return "GetService (0x" + hr.ToString("X8") + ")"; }
            capClient = c; capSvc = (IAudioCaptureClient)o; capEvent = ev; capPcm16 = v.Pcm16; capName = v.Name;
            return null;
        } finally { Marshal.FreeCoTaskMem(fmt); }
    }

    // Diagnostic: open every capture variant on its own against Spotify,
    // read ~0.6 s from it, report what worked. Touches no routing, no mutes
    // and no speakers, so it is safe to run any time.
    static void CapTest() {
        uint pid = SpotifyRoot();
        Emit("CAPTEST build " + WindowsBuild() + " spotify " + pid);
        if (pid == 0) return;
        if (capSvc != null) { Emit("CAPTEST busy"); return; }
        for (int i = 0; i < CAP_VARIANTS.Length; i++) {
            CapVariant v = CAP_VARIANTS[i];
            string err = TryCapture(pid, v);
            if (err != null) { Emit("CAPTEST " + i + " FAIL " + err + " | " + v.Name); continue; }
            long frames = 0; double sum = 0;
            try {
                capClient.Start();
                Stopwatch sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < 600) {
                    if (capEvent != null) capEvent.WaitOne(20); else Thread.Sleep(5);
                    uint pk; capSvc.GetNextPacketSize(out pk);
                    while (pk > 0) {
                        IntPtr data; uint fr, fl; ulong a, b;
                        if (capSvc.GetBuffer(out data, out fr, out fl, out a, out b) < 0) break;
                        int n = (int)fr;
                        if ((fl & 2) == 0 && data != IntPtr.Zero) {
                            if (v.Pcm16) { short[] t = new short[n * 2]; Marshal.Copy(data, t, 0, n * 2); for (int k = 0; k < t.Length; k++) { double x = t[k] / 32768.0; sum += x * x; } }
                            else { float[] t = new float[n * 2]; Marshal.Copy(data, t, 0, n * 2); for (int k = 0; k < t.Length; k++) sum += t[k] * (double)t[k]; }
                        }
                        frames += n;
                        capSvc.ReleaseBuffer(fr);
                        capSvc.GetNextPacketSize(out pk);
                    }
                }
            } catch (Exception e) { Emit("CAPTEST " + i + " FAIL read " + e.Message + " | " + v.Name); }
            double rms = frames > 0 ? Math.Sqrt(sum / (frames * 2)) : 0;
            Emit("CAPTEST " + i + " OK frames " + frames + " rms " + rms.ToString("F4", CultureInfo.InvariantCulture) + " | " + v.Name);
            StopStream();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct OSVERSIONINFOW { public int size, major, minor, build, platform; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string csd; }
    [DllImport("ntdll.dll")] static extern int RtlGetVersion(ref OSVERSIONINFOW v);
    static int winBuild = -1;
    // The real build (Environment.OSVersion lies to unmanifested .NET apps).
    static int WindowsBuild() {
        if (winBuild >= 0) return winBuild;
        try { OSVERSIONINFOW v = new OSVERSIONINFOW(); v.size = Marshal.SizeOf(typeof(OSVERSIONINFOW)); RtlGetVersion(ref v); winBuild = v.build; }
        catch (Exception) { winBuild = 0; }
        return winBuild;
    }

    static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")"); }

    static void StartStream(uint pid, string target) {
        int build = WindowsBuild();
        if (build > 0 && build < 19041)
            throw new Exception("Bass Boost needs Windows 10 version 2004 or newer, or Windows 11 (this PC is build " + build + ")");

        // 1. Spotify's audio, down the ladder.
        List<int> order = new List<int>();
        if (forceCap >= 0 && forceCap < CAP_VARIANTS.Length) order.Add(forceCap);
        else { order.Add(lastGoodCap); for (int i = 0; i < CAP_VARIANTS.Length; i++) if (i != lastGoodCap) order.Add(i); }
        string tried = "", lastErr = "";
        int chosen = -1;
        foreach (int i in order) {
            string err = TryCapture(pid, CAP_VARIANTS[i]);
            if (err == null) { chosen = i; break; }
            lastErr = err;
            tried += CAP_VARIANTS[i].Name + ": " + err + "; ";
        }
        if (tried.Length > 0) Log("capture attempts on Windows build " + build + ": " + tried);
        if (chosen < 0)
            throw new Exception("Listening to Spotify failed on Windows build " + build + " — " + lastErr);
        lastGoodCap = chosen;
        int rate = CAP_VARIANTS[chosen].Rate;
        if (rate != RATE) { RATE = rate; win = null; Emit("RATE " + RATE); }

        // 2. The speakers, at the same rate (float; Windows converts if it must).
        IntPtr fmt = MakeFormat(RATE, false);
        try {
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
            IMMDevice dev;
            Check(en.GetDevice(target, out dev), "Opening the speakers");
            object o;
            Guid iid = IID_IAudioClient;
            Check(dev.Activate(ref iid, 23, IntPtr.Zero, out o), "Opening the speakers");
            renClient = (IAudioClient)o;
            int hr = renClient.Initialize(0, AUTOCONVERT | SRCDEFAULT, 1000000, 0, fmt, IntPtr.Zero);
            if (hr < 0) {
                // Same story as capture: some builds refuse the quality flag.
                Release(renClient);
                Check(dev.Activate(ref iid, 23, IntPtr.Zero, out o), "Opening the speakers");
                renClient = (IAudioClient)o;
                Check(renClient.Initialize(0, AUTOCONVERT, 1000000, 0, fmt, IntPtr.Zero), "Starting the speakers");
            }
            Check(renClient.GetBufferSize(out renFrames), "Starting the speakers");
            iid = IID_Render;
            Check(renClient.GetService(ref iid, out o), "Starting the speakers");
            renSvc = (IAudioRenderClient)o;

            Check(renClient.Start(), "Starting the speakers");
            Check(capClient.Start(), "Listening to Spotify");
            curPid = pid;
            curTarget = target;
            streamLost = false;
            ResetDsp();
            Log("listening to Spotify via " + capName + " at " + RATE + " Hz on Windows build " + build);
        } finally {
            Marshal.FreeCoTaskMem(fmt);
        }
    }

    static IAudioClient ActivateLoopback(uint pid, out int hrOut) {
        IntPtr ap = Marshal.AllocCoTaskMem(12);
        IntPtr pv = Marshal.AllocCoTaskMem(24);
        try {
            Marshal.WriteInt32(ap, 0, 1);              // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            Marshal.WriteInt32(ap, 4, (int)pid);
            Marshal.WriteInt32(ap, 8, 0);              // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
            Marshal.WriteInt16(pv, 0, 65);             // VT_BLOB
            Marshal.WriteInt32(pv, 8, 12);
            Marshal.WriteIntPtr(pv, IntPtr.Size == 8 ? 16 : 12, ap);
            ActivationHandler h = new ActivationHandler();
            IActivateAudioInterfaceAsyncOperation op;
            Guid iid = IID_IAudioClient;
            int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, h, out op);
            if (hr < 0) { hrOut = hr; return null; }
            if (!h.Done.WaitOne(5000)) { hrOut = -1; return null; }
            hrOut = h.Hr;
            return h.Hr >= 0 ? h.Result as IAudioClient : null;
        } finally {
            Marshal.FreeCoTaskMem(ap);
            Marshal.FreeCoTaskMem(pv);
        }
    }

    static void StopStream() {
        try { if (capClient != null) capClient.Stop(); } catch (Exception) { }
        try { if (renClient != null) renClient.Stop(); } catch (Exception) { }
        Release(capSvc); Release(capClient); Release(renSvc); Release(renClient);
        capSvc = null; capClient = null; renSvc = null; renClient = null;
        if (capEvent != null) { try { capEvent.Close(); } catch (Exception) { } capEvent = null; }
        curPid = 0;
        streamLost = false;
    }

    static void Release(object o) { try { if (o != null) Marshal.ReleaseComObject(o); } catch (Exception) { } }

    // ── the per-packet path ──
    static float[] buf = new float[4096];
    static readonly float[] silence = new float[960 * 2];
    static double[][] st = new double[0][];
    static double[] hst = new double[4];
    static double[] xst = new double[8], xhs = new double[8];
    static double env = 1, grMin = 1, peakOut = 0, bDet = 0, bgMin = 1, bGain = 1;
    static int bHold = 0;
    static readonly float[] ring = new float[METER_N];
    static int ringPos = 0, sinceMeter = 0;
    static double latAcc = 0; static int latN = 0;

    static void ResetDsp() {
        st = new double[0][];
        hst = new double[4];
        xst = new double[8]; xhs = new double[8];
        env = 1;
        bDet = 0; bGain = 1; bHold = 0;
    }

    static void Pump() {
        uint pk;
        int hr = capSvc.GetNextPacketSize(out pk);
        if (hr < 0) { streamLost = true; return; }
        while (pk > 0) {
            IntPtr data; uint fr, fl; ulong a, b;
            hr = capSvc.GetBuffer(out data, out fr, out fl, out a, out b);
            if (hr < 0) { streamLost = true; return; }
            int n = (int)fr;
            if (buf.Length < n * 2) buf = new float[n * 2];
            if ((fl & 2) != 0 || data == IntPtr.Zero) Array.Clear(buf, 0, n * 2);
            else if (capPcm16) {
                if (sbuf.Length < n * 2) sbuf = new short[n * 2];
                Marshal.Copy(data, sbuf, 0, n * 2);
                for (int i = 0; i < n * 2; i++) buf[i] = sbuf[i] / 32768f;
            }
            else Marshal.Copy(data, buf, 0, n * 2);
            capSvc.ReleaseBuffer(fr);
            Process(buf, n);
            Write(buf, n);
            hr = capSvc.GetNextPacketSize(out pk);
            if (hr < 0) { streamLost = true; return; }
        }
    }

    // Keeps the render cushion between ~20 and 60 ms: a starved buffer gets
    // 20 ms of silence first (so the next late packet doesn't click), and a
    // burst that would push it past 60 ms is trimmed, so delay never creeps.
    static void Write(float[] src, int n) {
        uint pad;
        int hr = renClient.GetCurrentPadding(out pad);
        if (hr < 0) { streamLost = true; return; }
        int free = (int)renFrames - (int)pad;
        int offset = 0;
        int prime = RATE / 50, cap = RATE * 3 / 50;             // 20 ms cushion, 60 ms ceiling
        if (pad == 0 && free >= prime + n) {
            IntPtr sp;
            if (renSvc.GetBuffer((uint)prime, out sp) >= 0) { Marshal.Copy(silence, 0, sp, prime * 2); renSvc.ReleaseBuffer((uint)prime, 0); pad = (uint)prime; free -= prime; }
        }
        int over = (int)pad + n - cap;
        if (over > 0) { int drop = Math.Min(over, n); offset += drop; n -= drop; }
        if (n > free) n = free;
        latAcc += (pad + n) / (RATE / 1000.0); latN++;
        if (n <= 0) return;
        IntPtr p;
        hr = renSvc.GetBuffer((uint)n, out p);
        if (hr < 0) { streamLost = true; return; }
        Marshal.Copy(src, offset * 2, p, n * 2);
        renSvc.ReleaseBuffer((uint)n, 0);
    }

    static double Bq(double[] c, double[] s, int o, double x) {
        double y = c[0] * x + s[o];
        s[o] = c[1] * x - c[3] * y + s[o + 1];
        s[o + 1] = c[2] * x - c[4] * y;
        return y;
    }

    static void Process(float[] b, int n) {
        Chain c = chain;
        int nb = c.Bq.Length;
        if (st.Length != nb) { st = new double[nb][]; for (int k = 0; k < nb; k++) st[k] = new double[4]; }
        double pre = c.Bypass ? 1 : c.Pre, outG = c.Bypass ? 1 : c.Out;
        double ceil = c.Ceil, rel = c.RelCoef;
        bool harm = !c.Bypass && c.Harm > 0.0001;
        for (int i = 0; i < n; i++) {
            double l = b[2 * i] * pre + 1e-18, r = b[2 * i + 1] * pre + 1e-18;
            if (!c.Bypass) {
                if (harm) {
                    double low = Bq(c.HarmLp, hst, 0, (l + r) * 0.5);
                    double h = Bq(c.HarmHp, hst, 2, Math.Tanh(low * 6.0) * 0.25);
                    l += c.Harm * h; r += c.Harm * h;
                }
                for (int k = 0; k < nb; k++) {
                    double[] q = c.Bq[k]; double[] s = st[k];
                    l = Bq(q, s, 0, l);
                    r = Bq(q, s, 2, r);
                }
                // Bass-only limiter: a Linkwitz-Riley (LR4) crossover splits
                // the signal into bands that sum back to an all-pass (flat), and
                // only the low band is squeezed — a kick never ducks the vocals.
                // (Subtracting a low-passed copy instead does NOT work: its
                // phase shift near the crossover leaves the bass untouched.)
                double lowL = Bq(c.XoLp, xst, 2, Bq(c.XoLp, xst, 0, l));
                double lowR = Bq(c.XoLp, xst, 6, Bq(c.XoLp, xst, 4, r));
                double highL = Bq(c.XoHp, xhs, 2, Bq(c.XoHp, xhs, 0, l));
                double highR = Bq(c.XoHp, xhs, 6, Bq(c.XoHp, xhs, 4, r));
                // Peak-hold detector: holds each peak for 25 ms (longer than one
                // cycle of the lowest bass note) so the gain doesn't ripple
                // within a wave — that ripple IS distortion — then releases.
                double bp = Math.Max(Math.Abs(lowL), Math.Abs(lowR));
                if (bp >= bDet) { bDet = bp; bHold = 1200; }
                else if (bHold > 0) bHold--;
                else bDet += (bp - bDet) * c.BassRel;
                double bt = bDet > c.BassCeil ? c.BassCeil / bDet : 1.0;
                bGain += (bt - bGain) * (bt < bGain ? c.BassAtk : c.BassRel);
                l = highL + bGain * lowL; r = highR + bGain * lowR;
                if (bGain < bgMin) bgMin = bGain;
            }
            l *= outG; r *= outG;
            double pk = Math.Max(Math.Abs(l), Math.Abs(r));
            double target = pk > ceil ? ceil / pk : 1.0;
            if (target < env) env = target; else env += (target - env) * rel;
            l *= env; r *= env;
            if (l > 1) l = 1; else if (l < -1) l = -1;
            if (r > 1) r = 1; else if (r < -1) r = -1;
            b[2 * i] = (float)l; b[2 * i + 1] = (float)r;
            if (env < grMin) grMin = env;
            double ap = Math.Max(Math.Abs(l), Math.Abs(r));
            if (ap > peakOut) peakOut = ap;
            ring[ringPos] = (float)((l + r) * 0.5);
            ringPos = (ringPos + 1) & (METER_N - 1);
        }
        sinceMeter += n;
        if (sinceMeter >= 1600) { sinceMeter = 0; if (meterOn) SendMeter(); grMin = 1; bgMin = 1; peakOut = 0; latAcc = 0; latN = 0; }
    }

    // ── spectrum ──
    static double[] re = new double[METER_N], im = new double[METER_N], win;
    static int[] bandLo, bandHi;

    static void SendMeter() {
        if (win == null) {
            win = new double[METER_N];
            for (int i = 0; i < METER_N; i++) win[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (METER_N - 1));
            bandLo = new int[BANDS]; bandHi = new int[BANDS];
            double binHz = (double)RATE / METER_N;
            for (int k = 0; k < BANDS; k++) {
                double f0 = 20 * Math.Pow(1000, (double)k / BANDS), f1 = 20 * Math.Pow(1000, (double)(k + 1) / BANDS);
                bandLo[k] = Math.Max(1, (int)Math.Floor(f0 / binHz));
                bandHi[k] = Math.Max(bandLo[k], (int)Math.Ceiling(f1 / binHz) - 1);
            }
        }
        for (int i = 0; i < METER_N; i++) { re[i] = ring[(ringPos + i) & (METER_N - 1)] * win[i]; im[i] = 0; }
        Fft(re, im);
        StringBuilder sb = new StringBuilder("LV ", 100);
        for (int k = 0; k < BANDS; k++) {
            double m = 0;
            for (int j = bandLo[k]; j <= bandHi[k] && j < METER_N / 2; j++) { double v = re[j] * re[j] + im[j] * im[j]; if (v > m) m = v; }
            double db = 10 * Math.Log10(m * 16.0 / ((double)METER_N * METER_N) + 1e-12);
            int v8 = (int)Math.Round((db + 72) / 72 * 255);
            if (v8 < 0) v8 = 0; if (v8 > 255) v8 = 255;
            sb.Append(v8.ToString("x2"));
        }
        double grDb = -20 * Math.Log10(Math.Max(grMin, 1e-6));
        int gr = (int)Math.Min(255, Math.Round(grDb / 24 * 255));
        int pk8 = (int)Math.Min(255, Math.Round(peakOut * 255));
        int lat = latN > 0 ? (int)Math.Round(latAcc / latN + 10) : 0;
        int bgr = (int)Math.Min(255, Math.Round(-20 * Math.Log10(Math.Max(bgMin, 1e-6)) / 24 * 255));
        sb.Append(' ').Append(gr).Append(' ').Append(pk8).Append(' ').Append(lat).Append(' ').Append(bgr);
        Emit(sb.ToString());
    }

    static void Fft(double[] xr, double[] xi) {
        int n = xr.Length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double t = xr[i]; xr[i] = xr[j]; xr[j] = t; t = xi[i]; xi[i] = xi[j]; xi[j] = t; }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len, wr = Math.Cos(ang), wi = Math.Sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int j = 0; j < len / 2; j++) {
                    int a = i + j, b2 = i + j + len / 2;
                    double ur = xr[a], ui = xi[a];
                    double vr = xr[b2] * cr - xi[b2] * ci, vi = xr[b2] * ci + xi[b2] * cr;
                    xr[a] = ur + vr; xi[a] = ui + vi; xr[b2] = ur - vr; xi[b2] = ui - vi;
                    double ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
                }
            }
        }
    }

    // Offline check that the chain does what renderer/bass-engine.js designed:
    // a quiet sine through the real Process(), steady-state gain in dB.
    static void TestDsp(double hz) {
        double[][] keepSt = st; double[] keepH = hst, keepX = xst, keepXh = xhs; double keepEnv = env, keepDet = bDet, keepBG = bGain;
        ResetDsp();
        int n = RATE; float[] x = new float[n * 2];
        double amp = 0.001;
        for (int i = 0; i < n; i++) { float v = (float)(amp * Math.Sin(2 * Math.PI * hz * i / RATE)); x[2 * i] = v; x[2 * i + 1] = v; }
        bool keepMeter = meterOn; meterOn = false;
        Process(x, n);
        meterOn = keepMeter;
        double sum = 0; int cnt = 0;
        for (int i = n / 2; i < n; i++) { sum += x[2 * i] * (double)x[2 * i]; cnt++; }
        double rms = Math.Sqrt(sum / cnt), ref0 = amp / Math.Sqrt(2);
        st = keepSt; hst = keepH; xst = keepX; xhs = keepXh; env = keepEnv; bDet = keepDet; bGain = keepBG;
        Emit("TESTDSP " + hz.ToString(CultureInfo.InvariantCulture) + " " + (20 * Math.Log10(rms / ref0)).ToString("F3", CultureInfo.InvariantCulture));
    }

    static double Goertzel(float[] x, int from, int n, double hz) {
        double w = 2 * Math.PI * hz / RATE, cw = 2 * Math.Cos(w), s1 = 0, s2 = 0;
        for (int i = 0; i < n; i++) { double s0 = x[2 * (from + i)] + cw * s1 - s2; s2 = s1; s1 = s0; }
        return Math.Sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2) * 2 / n;
    }

    static void TestMix(double loHz, double loAmp, double hiHz, double hiAmp) {
        double[][] keepSt = st; double[] keepH = hst, keepX = xst, keepXh = xhs; double keepEnv = env, keepDet = bDet, keepBG = bGain;
        ResetDsp();
        int n = RATE * 2; float[] x = new float[n * 2];
        for (int i = 0; i < n; i++) {
            float v = (float)(loAmp * Math.Sin(2 * Math.PI * loHz * i / RATE) + hiAmp * Math.Sin(2 * Math.PI * hiHz * i / RATE));
            x[2 * i] = v; x[2 * i + 1] = v;
        }
        bool keepMeter = meterOn; meterOn = false;
        Process(x, n);
        meterOn = keepMeter;
        int from = n / 2, len = RATE / 2;   // 0.5 s of steady state, a whole number of cycles of both tones
        double lo = Goertzel(x, from, len, loHz), hi = Goertzel(x, from, len, hiHz);
        st = keepSt; hst = keepH; xst = keepX; xhs = keepXh; env = keepEnv; bDet = keepDet; bGain = keepBG;
        Emit("TESTMIX " + (20 * Math.Log10(lo / loAmp)).ToString("F3", CultureInfo.InvariantCulture) + " " +
             (20 * Math.Log10(hi / hiAmp)).ToString("F3", CultureInfo.InvariantCulture));
    }

    // ── devices ──
    static List<Dev> ActiveOutputs() {
        List<Dev> list = new List<Dev>();
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
        string defId = null;
        IMMDevice def;
        if (en.GetDefaultAudioEndpoint(0, 1, out def) >= 0 && def != null) def.GetId(out defId);
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(0, 1, out col) < 0) return list;
        uint n; col.GetCount(out n);
        for (uint i = 0; i < n; i++) {
            IMMDevice d;
            if (col.Item(i, out d) < 0) continue;
            Dev x = new Dev();
            d.GetId(out x.Id);
            x.Name = FriendlyName(d);
            x.IsDefault = x.Id == defId;
            list.Add(x);
        }
        return list;
    }

    static string FriendlyName(IMMDevice d) {
        IPropertyStore store;
        if (d.OpenPropertyStore(0, out store) < 0 || store == null) return "Audio device";
        PKEY k = new PKEY(); k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;
        IntPtr pv = Marshal.AllocCoTaskMem(24);
        try {
            for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
            if (store.GetValue(ref k, pv) < 0) return "Audio device";
            if (Marshal.ReadInt16(pv) != 31) return "Audio device";      // VT_LPWSTR
            IntPtr s = Marshal.ReadIntPtr(pv, 8);
            string name = Marshal.PtrToStringUni(s);
            Marshal.FreeCoTaskMem(s);
            return name;
        } finally { Marshal.FreeCoTaskMem(pv); }
    }

    static string NameOf(string id) {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
        IMMDevice d;
        if (en.GetDevice(id, out d) < 0 || d == null) return null;
        return FriendlyName(d);
    }

    static string DevicesJson() {
        StringBuilder b = new StringBuilder("[");
        bool first = true;
        foreach (Dev d in ActiveOutputs()) {
            if (!first) b.Append(',');
            first = false;
            b.Append("{\"id\":").Append(J(d.Id)).Append(",\"name\":").Append(J(d.Name)).Append(",\"default\":").Append(d.IsDefault ? "true" : "false").Append('}');
        }
        return b.Append(']').ToString();
    }

    static IAudioEndpointVolume EpVol(string id) {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
        IMMDevice d;
        Check(en.GetDevice(id, out d), "Opening an output");
        object o; Guid iid = IID_EpVol;
        Check(d.Activate(ref iid, 23, IntPtr.Zero, out o), "Opening an output");
        return (IAudioEndpointVolume)o;
    }
    static int GetMute(string id) { int m; Check(EpVol(id).GetMute(out m), "Reading mute"); return m != 0 ? 1 : 0; }
    static void SetMute(string id, int m) { Guid ctx = Guid.Empty; Check(EpVol(id).SetMute(m, ref ctx), "Muting an output"); }

    // ── Spotify ──
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // Spotify's MAIN process: the Spotify.exe whose parent is not Spotify.
    // The per-app route API only accepts that one: handed a renderer,
    // utility or crashpad child it answers E_INVALIDARG (0x80070057). Picking
    // by start time used to land on a child, because they all start within
    // the same few milliseconds.
    static uint SpotifyRoot() {
        Dictionary<uint, uint> parent = new Dictionary<uint, uint>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap != IntPtr.Zero && snap != new IntPtr(-1)) {
            try {
                PROCESSENTRY32W e = new PROCESSENTRY32W();
                e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                bool ok = Process32FirstW(snap, ref e);
                while (ok) {
                    if (string.Equals(e.szExeFile, "Spotify.exe", StringComparison.OrdinalIgnoreCase)) parent[e.th32ProcessID] = e.th32ParentProcessID;
                    ok = Process32NextW(snap, ref e);
                }
            } finally { CloseHandle(snap); }
        }
        uint best = 0; int bestKids = -1;
        foreach (KeyValuePair<uint, uint> kv in parent) {
            if (parent.ContainsKey(kv.Value)) continue;            // a child of another Spotify
            int kids = 0;
            foreach (uint pp in parent.Values) if (pp == kv.Key) kids++;
            if (kids > bestKids) { bestKids = kids; best = kv.Key; }
        }
        return best;
    }

    // ── per-app route ──
    static IntPtr policy = IntPtr.Zero;
    // The factory's interface ID changed in build 21390: Windows 11 answers
    // only IID_Policy, Windows 10 (19041–19045) only IID_PolicyDownlevel —
    // each rejects the other with E_NOINTERFACE (verified on 26200). The
    // vtable is the same on both (slots 25/26), so only the ID differs.
    static Guid IID_PolicyDownlevel = new Guid("2a59116d-6c4f-45e0-a74f-707e3fef9258");
    static IntPtr Policy() {
        if (policy != IntPtr.Zero) return policy;
        string cls = "Windows.Media.Internal.AudioPolicyConfig";
        IntPtr h;
        Check(WindowsCreateString(cls, cls.Length, out h), "Audio routing");
        try {
            bool modern = WindowsBuild() >= 21390 || WindowsBuild() == 0;
            Guid first = modern ? IID_Policy : IID_PolicyDownlevel;
            Guid second = modern ? IID_PolicyDownlevel : IID_Policy;
            int hr = RoGetActivationFactory(h, ref first, out policy);
            if (hr < 0) {
                int hr2 = RoGetActivationFactory(h, ref second, out policy);
                if (hr2 < 0) throw new Exception("Audio routing isn't available on Windows build " + WindowsBuild() + " (0x" + hr.ToString("X8") + "/0x" + hr2.ToString("X8") + ")");
            }
        }
        finally { WindowsDeleteString(h); }
        return policy;
    }
    static IntPtr Slot(int i) { IntPtr vt = Marshal.ReadIntPtr(Policy()); return Marshal.ReadIntPtr(vt, i * IntPtr.Size); }
    static string FullId(string mmId) { return mmId == null ? null : @"\\?\SWD#MMDEVAPI#" + mmId + "#{e6327cad-dcec-4949-ae8a-991e976a79d2}"; }

    static string GetRoute(uint pid) {
        GetPersistedFn fn = (GetPersistedFn)Marshal.GetDelegateForFunctionPointer(Slot(26), typeof(GetPersistedFn));
        IntPtr h;
        Check(fn(Policy(), pid, 0, 1, out h), "Reading Spotify's output");
        if (h == IntPtr.Zero) return null;
        uint len;
        string r = Marshal.PtrToStringUni(WindowsGetStringRawBuffer(h, out len));
        WindowsDeleteString(h);
        return string.IsNullOrEmpty(r) ? null : r;
    }

    static void SetRoute(uint pid, string full) {
        SetPersistedFn fn = (SetPersistedFn)Marshal.GetDelegateForFunctionPointer(Slot(25), typeof(SetPersistedFn));
        IntPtr h = IntPtr.Zero;
        if (full != null) Check(WindowsCreateString(full, full.Length, out h), "Routing Spotify");
        try {
            Check(fn(Policy(), pid, 0, 0, h), "Routing Spotify");
            Check(fn(Policy(), pid, 0, 1, h), "Routing Spotify");
        } finally { if (h != IntPtr.Zero) WindowsDeleteString(h); }
    }

    // ── mute ledger ──
    // Every output this engine mutes is written here FIRST, with the mute
    // state it had before we ever touched it, and only struck off once it has
    // been put back. So a mute of ours can never be mistaken for the user's
    // own: two hosts overlapping, a crash or a kill could record OUR mute as
    // "it was already muted", and undoing that left the laptop speakers
    // silent for good. Anything still listed at boot is put back.
    static string LedgerPath() { return restorePath == null ? null : restorePath + ".mutes"; }

    static Dictionary<string, int> LedgerRead() {
        Dictionary<string, int> d = new Dictionary<string, int>();
        string p = LedgerPath();
        if (p == null || !File.Exists(p)) return d;
        try {
            foreach (string line in File.ReadAllLines(p)) {
                int tab = line.IndexOf('\t');
                if (tab > 0) d[line.Substring(0, tab)] = line.Substring(tab + 1).Trim() == "1" ? 1 : 0;
            }
        } catch (Exception) { }
        return d;
    }

    static void LedgerWrite(Dictionary<string, int> d) {
        string p = LedgerPath();
        if (p == null) return;
        try {
            if (d.Count == 0) { if (File.Exists(p)) File.Delete(p); return; }
            StringBuilder b = new StringBuilder();
            foreach (KeyValuePair<string, int> kv in d) b.Append(kv.Key).Append('\t').Append(kv.Value).Append('\n');
            string tmp = p + ".tmp";
            File.WriteAllText(tmp, b.ToString(), new UTF8Encoding(false));
            if (File.Exists(p)) File.Delete(p);
            File.Move(tmp, p);
        } catch (Exception e) { Log("couldn't save the mute ledger: " + e.Message); }
    }

    // The mute state an output had before this engine ever muted it.
    static int OriginalMute(string id) {
        int v;
        if (LedgerRead().TryGetValue(id, out v)) return v;
        return GetMute(id);
    }

    static void MuteSink(string id, int original) {
        Dictionary<string, int> d = LedgerRead();
        if (!d.ContainsKey(id)) { d[id] = original; LedgerWrite(d); }
        SetMute(id, 1);
    }

    static void UnmuteSink(string id) {
        Dictionary<string, int> d = LedgerRead();
        int original;
        if (!d.TryGetValue(id, out original)) original = sinkPrevMute;
        SetMute(id, original);
        d.Remove(id);
        LedgerWrite(d);
    }

    // Put back every output still listed (one we muted and never restored).
    // One that isn't connected right now stays listed and is retried later.
    static void SweepLedger() {
        Dictionary<string, int> d = LedgerRead();
        if (d.Count == 0) return;
        Dictionary<string, int> left = new Dictionary<string, int>();
        foreach (KeyValuePair<string, int> kv in d) {
            if (sinkMuteApplied && kv.Key == routeSink) { left[kv.Key] = kv.Value; continue; }
            try { SetMute(kv.Key, kv.Value); Log("put back an output's mute left by an earlier session"); }
            catch (Exception) { left[kv.Key] = kv.Value; }
        }
        LedgerWrite(left);
    }

    static void ApplyRoute(uint pid, string sink, string target) {
        if (!routeApplied) {
            string prev = GetRoute(pid);
            if (prev != null && prev.IndexOf(sink, StringComparison.OrdinalIgnoreCase) >= 0) prev = null;
            routePrev = prev;
            routeSink = sink;
            sinkPrevMute = OriginalMute(sink);
            routeApplied = true;
            sinkMuteApplied = true;
            SaveRestore();
            int targetMuted = GetMute(target);
            SetRoute(pid, FullId(sink));
            MuteSink(sink, sinkPrevMute);
            routedPid = pid;
            if (targetMuted == 0 && GetMute(target) == 1) {
                // The two outputs share one mute switch, so hiding Spotify's own
                // sound would silence ours too.
                UndoRoute();
                throw new Exception("These speakers share a mute switch with the spare output — choose another spare output");
            }
            Log("routed Spotify to the spare output");
            return;
        }
        // Keep it that way: re-assert if Spotify restarted, or the user
        // unmuted the spare output or moved Spotify by hand.
        string now = GetRoute(pid);
        if (now == null || now.IndexOf(sink, StringComparison.OrdinalIgnoreCase) < 0) SetRoute(pid, FullId(sink));
        routedPid = pid;
        if (GetMute(sink) == 0) MuteSink(sink, sinkPrevMute);
    }

    static void UndoRoute() {
        if (sinkMuteApplied && routeSink != null) {
            try { UnmuteSink(routeSink); } catch (Exception e) { Log("unmute failed: " + e.Message); }
            sinkMuteApplied = false;
        }
        if (routeApplied) {
            uint pid = SpotifyRoot();
            if (pid != 0) {
                try { SetRoute(pid, routePrev); routeApplied = false; }
                catch (Exception e) { Log("route reset failed: " + e.Message); }
            }
        }
        if (!routeApplied) { routeSink = null; routePrev = null; DeleteRestore(); }
        else SaveRestore();   // Spotify is closed: finish when it next runs
    }

    static void TryFinishPendingRoute() {
        uint pid = SpotifyRoot();
        if (pid == 0) return;
        try {
            SetRoute(pid, routePrev);
            routeApplied = false;
            routeSink = null; routePrev = null;
            DeleteRestore();
            Log("put Spotify's output back");
            lastStatus = "";
            Status("off", "");
        } catch (Exception e) { Log("pending route reset failed: " + e.Message); }
    }

    // ── restore file ──
    static void SaveRestore() {
        if (restorePath == null) return;
        try {
            string s = "sink\t" + (routeSink ?? "") + "\n" + "sinkMute\t" + sinkPrevMute + "\n" +
                       "muted\t" + (sinkMuteApplied ? 1 : 0) + "\n" + "routed\t" + (routeApplied ? 1 : 0) + "\n" +
                       "route\t" + (routePrev ?? "") + "\n";
            string tmp = restorePath + ".tmp";
            File.WriteAllText(tmp, s, new UTF8Encoding(false));
            if (File.Exists(restorePath)) File.Delete(restorePath);
            File.Move(tmp, restorePath);
        } catch (Exception e) { Log("couldn't save the restore file: " + e.Message); }
    }

    static void DeleteRestore() {
        try { if (restorePath != null && File.Exists(restorePath)) File.Delete(restorePath); } catch (Exception) { }
    }

    static void RestoreFromFile() {
        if (restorePath == null || !File.Exists(restorePath)) return;
        Dictionary<string, string> kv = new Dictionary<string, string>();
        foreach (string line in File.ReadAllLines(restorePath)) {
            int tab = line.IndexOf('\t');
            if (tab > 0) kv[line.Substring(0, tab)] = line.Substring(tab + 1);
        }
        string v;
        routeSink = kv.TryGetValue("sink", out v) && v.Length > 0 ? v : null;
        sinkPrevMute = kv.TryGetValue("sinkMute", out v) && v == "1" ? 1 : 0;
        sinkMuteApplied = kv.TryGetValue("muted", out v) && v == "1" && routeSink != null;
        routeApplied = kv.TryGetValue("routed", out v) && v == "1";
        routePrev = kv.TryGetValue("route", out v) && v.Length > 0 ? v : null;
        Log("restoring audio settings left by a previous session");
        UndoRoute();
    }
}
}
`;

const BASS_HOST_SCRIPT_CONTENT = `param([string]$RestoreFile, [int]$WatchPid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
if ($WatchPid -gt 0) { [MainBassBoost.Host]::Watch($RestoreFile, $WatchPid) }
else { [MainBassBoost.Host]::Run($RestoreFile, $PSCommandPath) }
`;

module.exports = { BASS_HOST_SCRIPT_CONTENT, BASS_HOST_SCRIPT_VERSION };
