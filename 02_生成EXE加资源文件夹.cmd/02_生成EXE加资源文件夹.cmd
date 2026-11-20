@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js 22.12+。请先运行 01_一键生成Windows安装包.cmd 或安装 Node.js。
  pause
  exit /b 1
)
if not exist node_modules\electron-builder (
  echo 尚未安装构建依赖，请先运行 01_一键生成Windows安装包.cmd。
  pause
  exit /b 1
)
call npm run check && call npm test && call npm run dist:win:dir
if errorlevel 1 goto failed
echo.
echo 生成成功：release\win-unpacked
 echo 双击其中的 FF14 Srank Desktop.exe 即可启动；resources 文件夹不要删除。
start "" "%~dp0release\win-unpacked"
pause
exit /b 0
:failed
echo 生成失败，请查看上方错误信息。
pause
exit /b 1
