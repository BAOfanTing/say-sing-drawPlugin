@echo off
rem 把本机网关暴露成 https（Cloudflare 快速隧道）。
rem cloudflared 不在 PATH 时，先设一次：
rem   set CLOUDFLARED=E:\Cache\qq-agent\tools\cloudflared.exe
if "%CLOUDFLARED%"=="" set CLOUDFLARED=cloudflared
echo 正在建立隧道，稍等几秒，输出里会出现 https://xxxx.trycloudflare.com
echo 把这个地址填进 QQ Agent → 插件 → 点歌唱歌 → 网关地址
echo.
"%CLOUDFLARED%" tunnel --url http://127.0.0.1:8899 --no-autoupdate --protocol http2
pause
