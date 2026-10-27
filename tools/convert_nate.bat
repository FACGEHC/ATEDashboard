@echo off
rem Convert NATE (CATE 2.0) TestStand ATML reports into NATE1001.mdb for the dashboard.
rem
rem   convert_nate.bat trial  [N]     first N reports (default 50) into NATE1001_trial.mdb, rebuilt every time, CSV copies kept
rem   convert_nate.bat sample [N]     N random reports (default 300) into NATE1001_trial.mdb, rebuilt, CSV copies kept
rem   convert_nate.bat full           every report into NATE1001.mdb (incremental: re-running only adds new reports)
rem   convert_nate.bat rebuild        delete NATE1001.mdb and convert everything again
rem Every mode also writes dashboard-ready CSVs (NATE1001_<Table>.csv) into _csv_<name> next to the database.
rem
rem Edit SRC / OUTDIR below if the archive or the target folder moves.
rem
rem How it works: HERE is this tools folder; SRC is the ATML archive and OUTDIR the data folder, both
rem relative to it. PS holds the PowerShell call to atml_to_mdb.ps1 with the source already set, and each
rem mode only adds the output name and the -Limit / -Sample / -Rebuild switches. Any other argument prints
rem the usage and exits with code 2. The default for N is applied inside the mode's own block.
setlocal
set "HERE=%~dp0"
set "SRC=%HERE%..\..\data\NATE CATE 2\DataArchive\FAC\FAC"
set "OUTDIR=%HERE%..\..\data\NATE CATE 2"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%atml_to_mdb.ps1" -Source "%SRC%""

rem mode dispatch: each block runs the converter and jumps to :done
if /i "%~1"=="trial"   ( set "N=%~2" & if "%~2"=="" set "N=50"
                         %PS% -Out "%OUTDIR%\NATE1001_trial.mdb" -Limit %N% -Rebuild -KeepCsv & goto :done )
if /i "%~1"=="sample"  ( set "N=%~2" & if "%~2"=="" set "N=300"
                         %PS% -Out "%OUTDIR%\NATE1001_trial.mdb" -Sample %N% -Rebuild -KeepCsv & goto :done )
if /i "%~1"=="full"    ( %PS% -Out "%OUTDIR%\NATE1001.mdb" -KeepCsv & goto :done )
if /i "%~1"=="rebuild" ( %PS% -Out "%OUTDIR%\NATE1001.mdb" -Rebuild -KeepCsv & goto :done )

echo usage: convert_nate.bat trial [N] ^| sample [N] ^| full ^| rebuild
echo   trial/sample write NATE1001_trial.mdb, full/rebuild write NATE1001.mdb; every mode also writes
echo   dashboard-ready CSVs (^<name^>_^<Table^>.csv) into _csv_^<name^>. Log: ^<database^>.import.log next to the database.
exit /b 2

rem reached after a successful conversion: remind how to verify the output
:done
echo.
echo Check the result with:
echo   python tools\verify_atml.py "%OUTDIR%\_csv_NATE1001_trial"      (independent re-parse of the XML vs. the CSV copies)
echo   node dev\test-nate.js "%OUTDIR%\NATE1001_trial.mdb" "%OUTDIR%\_csv_NATE1001_trial"   (dashboard reader vs. the CSV copies)
endlocal
