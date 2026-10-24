$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if (-not $request.requestId -or ([string]$request.title).Length -gt 300) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HandoffDesktop {
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
$form=New-Object Windows.Forms.Form
$form.Text='Work Handoff · 转交前选择'
$form.Size=New-Object Drawing.Size(640,350)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.MinimizeBox=$false
$form.TopMost=$true
$form.ShowInTaskbar=$true
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',11)
$heading=New-Object Windows.Forms.Label
$heading.Text='额度已达到转交阈值，是否打包转交？'
$heading.Location=New-Object Drawing.Point(24,22)
$heading.Size=New-Object Drawing.Size(580,32)
$heading.Font=New-Object Drawing.Font('Microsoft YaHei UI',13,[Drawing.FontStyle]::Bold)
$title=New-Object Windows.Forms.Label
$title.Text=[string]$request.title
$title.Location=New-Object Drawing.Point(24,66)
$title.Size=New-Object Drawing.Size(580,64)
$detail=New-Object Windows.Forms.Label
$detail.Text='30 秒内未回答将自动开始打包转交。点击“暂不转交”或关闭窗口则不转交。'
$detail.Location=New-Object Drawing.Point(24,139)
$detail.Size=New-Object Drawing.Size(580,48)
$count=New-Object Windows.Forms.Label
$count.Location=New-Object Drawing.Point(24,193)
$count.Size=New-Object Drawing.Size(580,30)
$yes=New-Object Windows.Forms.Button
$yes.Text='立即转交'
$yes.Location=New-Object Drawing.Point(300,243)
$yes.Size=New-Object Drawing.Size(135,42)
$no=New-Object Windows.Forms.Button
$no.Text='暂不转交'
$no.Location=New-Object Drawing.Point(451,243)
$no.Size=New-Object Drawing.Size(135,42)
$form.Controls.AddRange(@($heading,$title,$detail,$count,$yes,$no))
$script:shownAt=$null
$script:visibleMs=0L
$script:lastTick=0L
$script:answer='cancelled'
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress));[Console]::Out.Flush() }
$timer=New-Object Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ([HandoffDesktop]::Active() -and $form.Visible -and $form.WindowState -ne 'Minimized') {
    if ($null -eq $script:shownAt) {
      $script:shownAt=$now
      Emit @{kind='shown';requestId=$request.requestId;shownAt=$now;interactive=$true}
    }
    $gap=$now-$script:lastTick
    if ($script:lastTick -gt 0 -and $gap -le 2000) { $script:visibleMs+=$gap }
    $script:lastTick=$now
    $count.Text='未回答将于 '+[Math]::Max(0,[Math]::Ceiling((30000-$script:visibleMs)/1000))+' 秒后自动转交'
    if ($script:visibleMs -ge 30000) { $script:answer='timeout';$form.Close() }
  } else { $script:lastTick=0L;$count.Text='桌面不可交互，倒计时暂停；不会自动确认' }
})
$yes.Add_Click({$script:answer='handoff';$form.Close()})
$no.Add_Click({$script:answer='decline';$form.Close()})
$form.Add_Shown({$timer.Start();[System.Media.SystemSounds]::Exclamation.Play()})
$form.Add_FormClosed({
  $timer.Stop()
  if ($null -ne $script:shownAt) { Emit @{kind='answer';requestId=$request.requestId;shownAt=$script:shownAt;visibleMs=$script:visibleMs;answer=$script:answer} }
})
[Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
