@echo off
rem Export the result tables of an Access .mdb to dashboard-ready CSV files.
rem Usage: export_mdb.bat <path\to\CATE_1001.mdb> [output folder]
if "%~1"=="" ( echo Usage: %~nx0 ^<file.mdb^> [output folder] & exit /b 1 )
set OUT=%~2
if "%OUT%"=="" set OUT=%~dp1export_%~n1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_mdb.ps1" -Mdb "%~1" -OutDir "%OUT%"
