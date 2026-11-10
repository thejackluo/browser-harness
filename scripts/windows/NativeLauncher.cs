using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

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
                var input = Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);
                input.ContinueWith(task => { try { child.StandardInput.Close(); } catch (IOException) {} });
                var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var error = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch { return 1; }
    }

    private static string Quote(string value) { return "\"" + value + "\""; }
}
