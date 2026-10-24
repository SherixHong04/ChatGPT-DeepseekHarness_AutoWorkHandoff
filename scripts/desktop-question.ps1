param([switch]$Diagnose, [string]$PreviewDirectory, [switch]$RenderOnly, [ValidateSet('system','light','dark')][string]$Theme='system')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
if (-not $Diagnose) {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if (-not $request.requestId -or ([string]$request.title).Length -gt 300) { exit 2 }
}
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HandoffDesktop {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
  public static void EnableDpi() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static void Style(IntPtr window, bool dark) {
    int corner=2;DwmSetWindowAttribute(window,33,ref corner,4);
    int useDark=dark?1:0;DwmSetWindowAttribute(window,20,ref useDark,4);
  }
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out int value,int size);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x,y,width,height,xChars,yChars,fill,flags;
    public ushort show,reservedBytes; public IntPtr reserved2,stdin,stdout,stderr;
  }
  [DllImport("kernel32.dll")] static extern void GetStartupInfo(out StartupInfo info);
  static string Name(IntPtr obj) {
    int needed;var name=new StringBuilder(256);
    return GetUserObjectInformation(obj,2,name,512,out needed)?name.ToString():"unavailable";
  }
  public static string[] Context() {
    StartupInfo start;GetStartupInfo(out start);
    var desktop=OpenInputDesktop(0,false,1);
    try { return new[]{Name(GetProcessWindowStation()),Name(GetThreadDesktop(GetCurrentThreadId())),Name(desktop),start.flags.ToString(),start.show.ToString(),Process.GetCurrentProcess().SessionId.ToString()}; }
    finally {if(desktop!=IntPtr.Zero)CloseDesktop(desktop);}
  }
  public static bool Observable(IntPtr window) {
    if(!IsWindowVisible(window)||IsIconic(window))return false;
    int cloaked;if(DwmGetWindowAttribute(window,14,out cloaked,4)!=0||cloaked!=0)return false;
    Rect rect;if(!GetWindowRect(window,out rect)||rect.right<=rect.left||rect.bottom<=rect.top)return false;
    var point=new Point{x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2};
    var hit=WindowFromPoint(point);
    return hit==window||IsChild(window,hit);
  }
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder value,int length,out int needed);
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  public static bool Active() {
    IntPtr buffer;int bytes;
    if(!WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,8,out buffer,out bytes))return false;
    try { if(bytes<4 || Marshal.ReadInt32(buffer)!=0)return false; } finally { WTSFreeMemory(buffer); }
    var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;
    try { int needed;var name=new StringBuilder(256);return GetUserObjectInformation(desktop,2,name,512,out needed)&&name.ToString()=="Default"; }
    finally { CloseDesktop(desktop); }
  }
}
'@
if ($Diagnose) { [HandoffDesktop]::Context() | ConvertTo-Json -Compress; exit 0 }
[HandoffDesktop]::EnableDpi()
[AppContext]::SetSwitch('Switch.System.Windows.DoNotScaleForDpiChanges',$false)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$markup=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'desktop-question.xaml'),[Text.Encoding]::UTF8)
$reader=New-Object System.Xml.XmlNodeReader ([xml]$markup)
$form=[Windows.Markup.XamlReader]::Load($reader)
$dark=$Theme -eq 'dark'
if ($Theme -eq 'system') {
  $appearance=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue
  $dark=$null -ne $appearance -and $appearance.AppsUseLightTheme -eq 0
}
if (-not $dark) {
  $palette=@{Bg='#FFFFFF';Surface='#F3F6FB';Line='#DFE5EE';Text='#172033';Muted='#59677C';Accent='#265DB7';Track='#E4EBF7';Hover='#EDF1F7'}
  foreach($key in $palette.Keys) { $form.Resources[$key]=[Windows.Media.BrushConverter]::new().ConvertFromString($palette[$key]) }
}
$title=$form.FindName('TaskTitle');$title.Text=[string]$request.title;$title.ToolTip=[string]$request.title
$count=$form.FindName('Countdown');$progress=$form.FindName('Remaining')
$yes=$form.FindName('YesButton');$no=$form.FindName('NoButton');$close=$form.FindName('CloseButton')
$script:handle=[IntPtr]::Zero
$script:shownAt=$null
$script:visibleMs=0L
$script:lastTick=0L
$script:answer='cancelled'
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress));[Console]::Out.Flush() }
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ([HandoffDesktop]::Active() -and $form.IsVisible -and [HandoffDesktop]::Observable($script:handle)) {
    if ($null -eq $script:shownAt) {
      $script:shownAt=$now
      Emit @{kind='shown';requestId=$request.requestId;shownAt=$now;interactive=$true;ui='compact-wpf';dpi=[HandoffDesktop]::GetDpiForWindow($script:handle)}
    }
    $gap=$now-$script:lastTick
    if ($script:lastTick -gt 0 -and $gap -le 2000) { $script:visibleMs+=$gap }
    $script:lastTick=$now
    $count.Text=([Math]::Max(0,[Math]::Ceiling((30000-$script:visibleMs)/1000))).ToString('0')+' 秒后自动转交'
    $progress.Value=[Math]::Max(0,30000-$script:visibleMs)
    if ($script:visibleMs -ge 30000) { $script:answer='timeout';$form.Close() }
  } else { $script:lastTick=0L;$count.Text='倒计时已暂停' }
})
$yes.Add_Click({$script:answer='handoff';$form.Close()})
$no.Add_Click({$script:answer='decline';$form.Close()})
$close.Add_Click({$script:answer='cancelled';$form.Close()})
$form.Add_KeyDown({if($_.Key -eq 'Escape'){$script:answer='cancelled';$form.Close()}})
$form.Add_SourceInitialized({
  $script:handle=([Windows.Interop.WindowInteropHelper]::new($form)).Handle
  [HandoffDesktop]::Style($script:handle,$dark)
})
$form.Add_ContentRendered({
  if ($PreviewDirectory) {
    $directory=[IO.Path]::GetFullPath($PreviewDirectory)
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    foreach($dpi in @(96,144,192)) {
      $visual=$form.Content
      $bitmap=[Windows.Media.Imaging.RenderTargetBitmap]::new([int][Math]::Ceiling($visual.ActualWidth*$dpi/96),[int][Math]::Ceiling($visual.ActualHeight*$dpi/96),$dpi,$dpi,[Windows.Media.PixelFormats]::Pbgra32)
      $bitmap.Render($visual)
      $encoder=[Windows.Media.Imaging.PngBitmapEncoder]::new();$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
      $stream=[IO.File]::Create((Join-Path $directory ('prompt-'+$Theme+'-'+$dpi+'.png')))
      try {$encoder.Save($stream)} finally {$stream.Dispose()}
    }
    $source=[Windows.PresentationSource]::FromVisual($form)
    $metrics=@{width=$form.ActualWidth;height=$form.ActualHeight;dpi=[HandoffDesktop]::GetDpiForWindow($script:handle);scale=$source.CompositionTarget.TransformToDevice.M11;theme=$Theme;title=$title.Text;font=$title.FontFamily.Source;titleHeight=$title.ActualHeight;titleMaxHeight=$title.MaxHeight;yesWidth=$yes.ActualWidth;noWidth=$no.ActualWidth;buttonHeight=$yes.ActualHeight}
    [IO.File]::WriteAllText((Join-Path $directory ('metrics-'+$Theme+'.json')),($metrics | ConvertTo-Json),[Text.Encoding]::UTF8)
  }
  if ($RenderOnly) {$script:answer='cancelled';$form.Close();return}
  $timer.Start();[System.Media.SystemSounds]::Exclamation.Play()
})
$form.Add_Closed({
  $timer.Stop()
  if ($null -ne $script:shownAt) { Emit @{kind='answer';requestId=$request.requestId;shownAt=$script:shownAt;visibleMs=$script:visibleMs;answer=$script:answer} }
})
$application=[Windows.Application]::new()
$application.ShutdownMode='OnMainWindowClose'
[void]$application.Run($form)
