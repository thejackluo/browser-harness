using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class NativeLauncher
{
    private const string Origin = "chrome-extension://dhgboignmjemkhkhknadoeagnoaibloh/";

    [STAThread]
    private static int Main(string[] args)
    {
        string folder = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length == 1 && args[0] == "--setup")
        {
            Process.Start(new ProcessStartInfo("explorer.exe", Quote(Path.Combine(folder, "extension"))) { UseShellExecute = true });
            Process.Start(new ProcessStartInfo(Path.Combine(folder, "first-run.html")) { UseShellExecute = true });
            return 0;
        }
        if (args.Length == 0 || args[0] != Origin) return 1;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(folder, "runtime", "node.exe"), Quote(Path.Combine(folder, "native-host.mjs")) + " " + Origin)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = folder
            };
            using (var child = Process.Start(start))
            {
                Stream childInput = child.StandardInput.BaseStream;
                var input = new Thread(() => { Pump(Console.OpenStandardInput(), childInput); Close(childInput); }) { IsBackground = true };
                var output = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                var error = new Thread(() => Pump(child.StandardError.BaseStream, Stream.Null)) { IsBackground = true };
                input.Start();
                output.Start();
                error.Start();
                child.WaitForExit();
                output.Join();
                return child.ExitCode;
            }
        }
        catch { return 1; }
    }

    // Chrome frames are small; flush every chunk so a buffered pipe never withholds a message.
    private static void Pump(Stream from, Stream to)
    {
        var buffer = new byte[16384];
        try
        {
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
        catch (IOException) {}
        catch (ObjectDisposedException) {}
    }

    private static void Close(Stream stream)
    {
        try { stream.Close(); } catch (IOException) {}
    }

    private static string Quote(string value) { return "\"" + value + "\""; }
}
