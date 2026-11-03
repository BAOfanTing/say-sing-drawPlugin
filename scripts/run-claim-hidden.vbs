' 静默领取 Breeze 每日额度。
' 原来的计划任务用 cmd.exe 直接跑 node.exe —— node 是控制台程序，每 2 小时会闪一个黑窗。
' 这里用 wscript（GUI 子系统，本身没控制台）+ 窗口样式 0，全程不出现窗口。
Option Explicit

Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """E:\APP\node.js\node.exe"" ""E:\Cache\qq-agent\say-sing-drawPlugin\scripts\claim-daily-credits.mjs""", 0, False
