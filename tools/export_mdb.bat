@echo off
rem Export the result tables of an Access .mdb to dashboard-ready CSV files.
rem Usage: export_mdb.bat <path\to\CATE_1001.mdb> [output folder]
rem Wraps tools\export_mdb.ps1 (ACE OLEDB export). The output folder defaults to export_<database name>
rem next to the .mdb; it receives <Machine>_<Table>.csv, <Machine>_<Table>.count.txt and the <Machine>.csv bundle.
rem Exit code 1 without arguments, otherwise PowerShell's exit code.
if "%~1"=="" ( echo Usage: %~nx0 ^<file.mdb^> [output folder] & exit /b 1 )
set OUT=%~2
if "%OUT%"=="" set OUT=%~dp1export_%~n1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_mdb.ps1" -Mdb "%~1" -OutDir "%OUT%"
