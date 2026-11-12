/**
 * Short program name for a GPU process.
 * nvidia-smi reports some processes (desktop GPU clients such as a browser's GPU process) by their whole
 * command line: "/opt/brave.com/brave/brave --type=gpu-process …" -> "brave".
 * Windows paths keep their spaces: "C:\Program Files\App\app.exe --flag" -> "app.exe".
 * Placeholders such as "[Not Found]" are returned unchanged.
 */
export function shortProcessName(name: string): string {
  const s = name.trim();
  if (!s || s.startsWith("[")) return s;
  const exe = /^"?(.*?\.exe)(?=["\s]|$)/i.exec(s);
  const program = exe ? exe[1] : s.split(/\s+/)[0];
  return program.split(/[\\/]/).pop() || s;
}
