import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';

const root=fileURLToPath(new URL('../..',import.meta.url));

function reservePort(){
 return new Promise((resolve,reject)=>{
  const listener=net.createServer();
  listener.once('error',reject);
  listener.listen(0,'127.0.0.1',()=>{
   const port=listener.address().port;
   listener.close(error=>error?reject(error):resolve(port));
  });
 });
}

function waitForExit(child,timeoutMs){
 return new Promise((resolve,reject)=>{
  if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
  let timer;
  const done=(error)=>{
   clearTimeout(timer);
   child.off('exit',onExit);
   child.off('error',onError);
   if(error)reject(error);else resolve();
  };
  const onExit=()=>done();
  const onError=error=>done(error);
  child.once('exit',onExit);
  child.once('error',onError);
  timer=setTimeout(()=>done(new Error(`Analytics child did not exit within ${timeoutMs}ms`)),timeoutMs);
  timer.unref?.();
 });
}

async function waitForReady(child,output,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(output.text.includes('Analytics ready at'))return;
  if(child.exitCode!==null||child.signalCode!==null){
   throw new Error(`Analytics child exited before readiness: ${output.text}`);
  }
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error(`Analytics child did not become ready within ${timeoutMs}ms: ${output.text}`);
}

async function waitForPort(port,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  try{
   await new Promise((resolve,reject)=>{
    const listener=net.createServer();
    listener.once('error',reject);
    listener.listen(port,'127.0.0.1',()=>listener.close(error=>error?reject(error):resolve()));
   });
   return;
  }catch{await new Promise(resolve=>setTimeout(resolve,25));}
 }
 throw new Error(`Analytics listener port ${port} remained occupied for ${timeoutMs}ms`);
}

function openLive(port){
 return new Promise((resolve,reject)=>{
  const request=http.get(`http://127.0.0.1:${port}/api/live`,response=>{
   response.once('error',reject);
   response.once('data',()=>resolve({request,response}));
  });
  request.once('error',reject);
 });
}

function lifecycleFixture(t,prefix='tma-process-lifecycle-'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return reservePort().then(port=>{
  const databasePath=path.join(dir,'analytics.db');
  const configPath=path.join(dir,'analytics.json');
  fs.writeFileSync(configPath,JSON.stringify({
   version:2,
   listen:{host:'127.0.0.1',port},
   publicOrigin:`http://127.0.0.1:${port}`,
   databasePath,
   timeZone:'UTC',
   detailRetentionDays:7,
   hubSecretsPath:path.join(dir,'hub-secrets.json'),
   viewerAuth:{mode:'loopback'},
   contracts:[],
   demo:false,
   management:{enabled:true},
   update:{enabled:false},
  }));
  return {dir,port,databasePath,configPath};
 });
}

function assertCleanDatabase(databasePath){
 const db=new DatabaseSync(databasePath,{readOnly:true});
 try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}
 finally{db.close();}
}

test('Analytics releases listener and SQLite after POSIX SIGINT or Windows forced termination API', {timeout: 20000}, async t=>{
 const {port,databasePath,configPath}=await lifecycleFixture(t);
 const output={text:''};
 const child=spawn(process.execPath,['--experimental-strip-types','analytics/runtime/server.mjs','--config',configPath],{
  cwd:root,
  env:{...process.env,TMA_NODE_LIFECYCLE_TEST:'1'},
  stdio:['ignore','pipe','pipe'],
  windowsHide:false,
 });
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{output.text+=chunk;});
 child.stderr.on('data',chunk=>{output.text+=chunk;});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');try{await waitForExit(child,2000);}catch{}}
 });

 await waitForReady(child,output,5000);
 const health=await fetch(`http://127.0.0.1:${port}/api/health`);
 assert.equal(health.status,200);
 assert.equal((await health.json()).storage,'sqlite');
 const live=await openLive(port);

 // POSIX delivers SIGINT to the JavaScript handler. Node's Windows
 // child.kill('SIGINT') API force-terminates instead of producing a console
 // control event, so this check only covers the bounded release contract on
 // Windows. The OS-native console event has its own Windows-only test below.
 assert.equal(child.kill('SIGINT'),true);
 await waitForExit(child,8000);
 live.request.destroy();live.response.destroy();
 await waitForPort(port,2000);
 assertCleanDatabase(databasePath);
});

const WINDOWS_CONSOLE_CTRL_C = String.raw`
Add-Type -ReferencedAssemblies 'System.Net.Http.dll' -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TmaConsoleControl {
  const uint CREATE_NEW_CONSOLE = 0x00000010;
  const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
  const uint WAIT_OBJECT_0 = 0x00000000;
  const uint CTRL_C_EVENT = 0;
  const uint STARTF_USESHOWWINDOW = 0x00000001;

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcess(string appName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInfo);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint eventType, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    if (value.IndexOfAny(new[] {' ', '\t', '"'}) < 0) return value;
    return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }

  public static int Run(string node, string entry, string config, string root, int port) {
    var command = new StringBuilder(Quote(node) + " --experimental-strip-types " + Quote(entry) + " --config " + Quote(config));
    var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), dwFlags = STARTF_USESHOWWINDOW, wShowWindow = 0 };
    PROCESS_INFORMATION process;
    if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, root, ref startup, out process)) {
      throw new InvalidOperationException("CreateProcess failed: " + Marshal.GetLastWin32Error());
    }
    try {
      using (var client = new System.Net.Http.HttpClient()) {
        var ready = false;
        for (var attempt = 0; attempt < 100; attempt++) {
          try {
            var response = client.GetAsync("http://127.0.0.1:" + port + "/api/health").GetAwaiter().GetResult();
            if ((int)response.StatusCode == 200) { ready = true; break; }
          } catch { }
          Thread.Sleep(100);
        }
        if (!ready) throw new InvalidOperationException("child Analytics process did not become ready");
      }
      // Attach to the disposable child console, deliver a real CTRL_C_EVENT,
      // then detach before waiting for clean shutdown.
      FreeConsole();
      if (!AttachConsole(process.dwProcessId)) throw new InvalidOperationException("AttachConsole failed: " + Marshal.GetLastWin32Error());
      // CTRL_C_EVENT uses process-group zero on Windows. Ignore it in this
      // helper so the event reaches the Analytics child without terminating
      // the controller that is waiting for its exit.
      if (!SetConsoleCtrlHandler(IntPtr.Zero, true)) throw new InvalidOperationException("SetConsoleCtrlHandler failed: " + Marshal.GetLastWin32Error());
      if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)) throw new InvalidOperationException("GenerateConsoleCtrlEvent failed: " + Marshal.GetLastWin32Error());
      SetConsoleCtrlHandler(IntPtr.Zero, false);
      FreeConsole();
      if (WaitForSingleObject(process.hProcess, 8000) != WAIT_OBJECT_0) {
        TerminateProcess(process.hProcess, 124);
        throw new TimeoutException("child Analytics process did not exit after CTRL_C_EVENT");
      }
      uint code;
      if (!GetExitCodeProcess(process.hProcess, out code)) throw new InvalidOperationException("GetExitCodeProcess failed: " + Marshal.GetLastWin32Error());
      return unchecked((int)code);
    } catch {
      TerminateProcess(process.hProcess, 125);
      throw;
    } finally {
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
    }
  }
}
'@

$exitCode = [TmaConsoleControl]::Run(
  $env:TMA_NODE_LIFECYCLE_NODE,
  $env:TMA_NODE_LIFECYCLE_ENTRY,
  $env:TMA_NODE_LIFECYCLE_CONFIG,
  $env:TMA_NODE_LIFECYCLE_ROOT,
  [int]$env:TMA_NODE_LIFECYCLE_PORT
)
Write-Output "child-exit-code=$exitCode"
if ($exitCode -ne 0) { exit 1 }
`;

function runWindowsConsoleCtrlC({port,configPath}){
 const encoded=Buffer.from(WINDOWS_CONSOLE_CTRL_C,'utf16le').toString('base64');
 const powershell=process.env.SystemRoot
  ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
  : 'powershell.exe';
 return new Promise((resolve,reject)=>{
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{
   cwd:root,
   env:{...process.env,TMA_NODE_LIFECYCLE_NODE:process.execPath,TMA_NODE_LIFECYCLE_ENTRY:path.join(root,'analytics','runtime','server.mjs'),TMA_NODE_LIFECYCLE_CONFIG:configPath,TMA_NODE_LIFECYCLE_PORT:String(port),TMA_NODE_LIFECYCLE_ROOT:root},
   stdio:['ignore','pipe','pipe'],
   windowsHide:true,
  });
  let output='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Windows console helper timed out: ${output}`));},15000);
  timer.unref?.();
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',(code,signal)=>{
   clearTimeout(timer);
   if(code===0)resolve(output);else reject(new Error(`Windows console helper failed (${code ?? signal}): ${output}`));
  });
 });
}

test('Windows console Ctrl+C event reaches Analytics and releases SQLite', {skip: process.platform!=='win32', timeout: 30000}, async t=>{
 const {port,databasePath,configPath}=await lifecycleFixture(t,'tma-process-console-');
 const output=await runWindowsConsoleCtrlC({port,configPath});
 assert.match(output,/child-exit-code=0/);
 assertCleanDatabase(databasePath);
 await waitForPort(port,2000);
});
