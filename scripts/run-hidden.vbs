' 静默启动器：用 wscript.exe（GUI 子系统，本身没有控制台）去跑 powershell，
' 这样任务栏不会闪出黑色窗口 —— powershell.exe 的 -WindowStyle Hidden 只能"起来后再藏"，
' 中间那一下照样会闪，这个不会。
'
' 用法：
'   wscript.exe //B run-hidden.vbs <要跑的 .ps1 路径> [参数...]
'
' 例（计划任务里直接这么写，路径没空格就不用引号）：
'   wscript.exe //B E:\Cache\qq-agent\say-sing-drawPlugin\scripts\run-hidden.vbs
'       E:\Cache\qq-agent\say-sing-drawPlugin\scripts\run-gateway-forever.ps1
Option Explicit

Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count = 0 Then WScript.Quit 2

cmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File """ _
      & WScript.Arguments(0) & """"

For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next

' 0 = 完全隐藏窗口；False = 不等待（由它自己常驻）
sh.Run cmd, 0, False
