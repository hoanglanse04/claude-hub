const { execFile } = require('node:child_process');
const path = require('node:path');

// The browser can't hand back a real folder path, so the hub opens the Windows folder dialog itself.
// IFileOpenDialog with FOS_PICKFOLDERS is the modern Explorer-style picker (FolderBrowserDialog is the
// old tree). It is owned by the window that was in front when the user clicked, i.e. the hub window,
// so it opens on top of it instead of behind.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HubFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(); void Compare();
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem item); void SetFolder(IShellItem item);
    void GetFolder(); void GetCurrentSelection(); void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel(); void GetResult(out IShellItem item);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr ctx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  public static string Pick(string title, string initial) {
    var dlg = (IFileOpenDialog)new FileOpenDialog();
    uint fos; dlg.GetOptions(out fos);
    dlg.SetOptions(fos | 0x20 | 0x40 | 0x8); // PICKFOLDERS | FORCEFILESYSTEM | NOCHANGEDIR
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("Chọn thư mục này");
    if (!string.IsNullOrEmpty(initial)) {
      try { IShellItem start; SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out start); dlg.SetFolder(start); } catch { } // missing folder: open at the default place
    }
    if (dlg.Show(GetForegroundWindow()) != 0) return null; // cancelled
    IShellItem item; dlg.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
$picked = [HubFolderPicker]::Pick($env:HUB_PICK_TITLE, $env:HUB_PICK_INITIAL)
if ($picked) { [Console]::Out.Write($picked) }
`;

let busy = false;

// Resolves to the chosen folder, or null when the user cancels.
function pickFolder({ title = 'Chọn thư mục', initial = '' } = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(Object.assign(new Error('Hộp chọn thư mục hiện chỉ có trên Windows, hãy dán đường dẫn'), { status: 501 }));
  }
  if (busy) return Promise.reject(Object.assign(new Error('Hộp chọn thư mục đang mở'), { status: 409 }));
  busy = true;
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      env: { ...process.env, HUB_PICK_TITLE: title, HUB_PICK_INITIAL: initial ? path.resolve(initial) : '' },
      windowsHide: true,
      timeout: 15 * 60 * 1000,
    }, (err, stdout, stderr) => {
      busy = false;
      if (err) return reject(new Error(`Không mở được hộp chọn thư mục: ${String(stderr || err.message).trim().split('\n')[0]}`));
      resolve(String(stdout).trim() || null);
    });
  });
}

module.exports = { pickFolder };
