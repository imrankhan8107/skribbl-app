@echo off
REM ============================================================
REM  Skribbl JMeter Performance Test Runner (Windows)
REM ============================================================
REM
REM  Usage:
REM    run_test.bat                                    (defaults: localhost:8000, smoke)
REM    run_test.bat --profile smoke                    (quick validation: 2 rooms, 30s)
REM    run_test.bat --profile load                     (standard load: 10 rooms, 180s)
REM    run_test.bat --profile stress                   (stress test: 25 rooms, 300s)
REM    run_test.bat --profile spike                    (spike test: 50 rooms, 60s)
REM    run_test.bat --host myapp.com --port 443 --profile load
REM    run_test.bat --test http                        (HTTP-only test)
REM    run_test.bat --test ws                          (WebSocket-only test)
REM    run_test.bat --test e2e                         (End-to-end game flow test)
REM    run_test.bat --test all                         (all tests sequentially)
REM
REM ============================================================

SETLOCAL EnableDelayedExpansion

REM === Defaults ===
SET HOST=localhost
SET PORT=8000
SET PROFILE=smoke
SET TEST_TYPE=ws

REM === Parse Arguments ===
:parse_args
IF "%~1"=="" GOTO done_args
IF /I "%~1"=="--host" (SET HOST=%~2& SHIFT & SHIFT & GOTO parse_args)
IF /I "%~1"=="--port" (SET PORT=%~2& SHIFT & SHIFT & GOTO parse_args)
IF /I "%~1"=="--profile" (SET PROFILE=%~2& SHIFT & SHIFT & GOTO parse_args)
IF /I "%~1"=="--test" (SET TEST_TYPE=%~2& SHIFT & SHIFT & GOTO parse_args)
IF /I "%~1"=="--help" GOTO show_help
SHIFT
GOTO parse_args
:done_args

REM === Profile Configuration ===
IF /I "%PROFILE%"=="smoke" (
    SET ROOMS=2
    SET PLAYERS_PER_ROOM=2
    SET RAMP_UP=5
    SET DURATION=30
    SET SUSTAINED=5
    SET HTTP_THREADS=20
    SET TARGET_RPS=50
    SET TURN_DURATION=30
)
IF /I "%PROFILE%"=="load" (
    SET ROOMS=10
    SET PLAYERS_PER_ROOM=4
    SET RAMP_UP=30
    SET DURATION=180
    SET SUSTAINED=20
    SET HTTP_THREADS=100
    SET TARGET_RPS=500
    SET TURN_DURATION=60
)
IF /I "%PROFILE%"=="stress" (
    SET ROOMS=25
    SET PLAYERS_PER_ROOM=6
    SET RAMP_UP=60
    SET DURATION=300
    SET SUSTAINED=50
    SET HTTP_THREADS=200
    SET TARGET_RPS=1000
    SET TURN_DURATION=45
)
IF /I "%PROFILE%"=="spike" (
    SET ROOMS=50
    SET PLAYERS_PER_ROOM=4
    SET RAMP_UP=10
    SET DURATION=60
    SET SUSTAINED=30
    SET HTTP_THREADS=300
    SET TARGET_RPS=2000
    SET TURN_DURATION=30
)
IF /I "%PROFILE%"=="soak" (
    SET ROOMS=20
    SET PLAYERS_PER_ROOM=5
    SET RAMP_UP=60
    SET DURATION=3600
    SET SUSTAINED=20
    SET HTTP_THREADS=50
    SET TARGET_RPS=200
    SET TURN_DURATION=60
)

REM === Resolve JMeter executable ===
SET JMETER_CMD=
IF NOT "%JMETER_HOME%"=="" (
    IF EXIST "%JMETER_HOME%\bin\jmeter.bat" (
        SET "JMETER_CMD=%JMETER_HOME%\bin\jmeter.bat"
    ) ELSE (
        echo WARNING: JMETER_HOME is set but jmeter.bat not found at %JMETER_HOME%\bin\jmeter.bat
    )
)
IF "%JMETER_CMD%"=="" (
    REM Try to find jmeter on PATH
    where jmeter >nul 2>&1
    IF %ERRORLEVEL% EQU 0 (
        SET "JMETER_CMD=jmeter"
    ) ELSE (
        echo.
        echo ERROR: JMeter not found. Either:
        echo   1. Set JMETER_HOME to your JMeter installation directory, OR
        echo   2. Add JMeter's bin folder to your system PATH
        echo.
        echo Example: SET JMETER_HOME=C:\apache-jmeter-5.6.3
        echo      or: Add C:\apache-jmeter-5.6.3\bin to PATH
        echo.
        exit /b 1
    )
)

REM === Setup paths ===
SET SCRIPT_DIR=%~dp0
SET RESULTS_DIR=%SCRIPT_DIR%results
SET TIMESTAMP=%DATE:~-4%%DATE:~4,2%%DATE:~7,2%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
SET TIMESTAMP=%TIMESTAMP: =0%
SET RUN_DIR=%RESULTS_DIR%\%PROFILE%_%TIMESTAMP%

echo.
echo ============================================================
echo   Skribbl Performance Test Suite
echo ============================================================
echo   Host:       %HOST%:%PORT%
echo   Profile:    %PROFILE%
echo   Test Type:  %TEST_TYPE%
echo   Timestamp:  %TIMESTAMP%
echo ------------------------------------------------------------
IF /I "%TEST_TYPE%"=="ws" GOTO show_ws_params
IF /I "%TEST_TYPE%"=="all" GOTO show_ws_params
GOTO show_http_params

:show_ws_params
echo   [WebSocket]
echo     Rooms:              %ROOMS%
echo     Players/Room:       %PLAYERS_PER_ROOM%
echo     Sustained Conns:    %SUSTAINED%
echo     Ramp-up:            %RAMP_UP%s
echo     Duration:           %DURATION%s
IF /I "%TEST_TYPE%"=="all" GOTO show_http_params
GOTO show_output

:show_http_params
echo   [HTTP]
echo     Threads:            %HTTP_THREADS%
echo     Target RPS:         %TARGET_RPS%
echo     Duration:           %DURATION%s

:show_output
echo ------------------------------------------------------------
echo   Output:     %RUN_DIR%
echo ============================================================
echo.

REM === Create output directories ===
IF NOT EXIST "%RESULTS_DIR%" mkdir "%RESULTS_DIR%"
mkdir "%RUN_DIR%" 2>nul
mkdir "%RUN_DIR%\ws" 2>nul
mkdir "%RUN_DIR%\http" 2>nul
mkdir "%RUN_DIR%\e2e" 2>nul

REM === Run WebSocket Test ===
IF /I "%TEST_TYPE%"=="http" GOTO run_http
IF /I "%TEST_TYPE%"=="e2e" GOTO run_e2e

echo [%TIME%] Starting WebSocket Performance Test...
echo.

"%JMETER_CMD%" -n ^
    -t "%SCRIPT_DIR%skribbl_websocket_test.jmx" ^
    -JHOST=%HOST% ^
    -JPORT=%PORT% ^
    -JROOMS=%ROOMS% ^
    -JPLAYERS_PER_ROOM=%PLAYERS_PER_ROOM% ^
    -JRAMP_UP=%RAMP_UP% ^
    -JDURATION=%DURATION% ^
    -JSUSTAINED_THREADS=%SUSTAINED% ^
    -l "%RUN_DIR%\ws\results.jtl" ^
    -e -o "%RUN_DIR%\ws\report"

SET WS_EXIT=%ERRORLEVEL%

IF %WS_EXIT% EQU 0 (
    echo.
    echo [PASS] WebSocket test completed successfully.
    echo        Report: %RUN_DIR%\ws\report\index.html
) ELSE (
    echo.
    echo [WARN] WebSocket test exited with code %WS_EXIT%
)
echo.

IF /I "%TEST_TYPE%"=="ws" GOTO summary

:run_e2e
REM === Run E2E Game Flow Test ===
echo [%TIME%] Starting E2E Game Flow Test...
echo.

"%JMETER_CMD%" -n ^
    -t "%SCRIPT_DIR%skribbl_e2e_game_flow.jmx" ^
    -JHOST=%HOST% ^
    -JPORT=%PORT% ^
    -JGAME_SESSIONS=%ROOMS% ^
    -JPLAYERS_PER_GAME=%PLAYERS_PER_ROOM% ^
    -JNUM_ROUNDS=2 ^
    -JTURN_DURATION=%TURN_DURATION% ^
    -l "%RUN_DIR%\e2e\results.jtl" ^
    -e -o "%RUN_DIR%\e2e\report"

SET E2E_EXIT=%ERRORLEVEL%

IF %E2E_EXIT% EQU 0 (
    echo.
    echo [PASS] E2E Game Flow test completed successfully.
    echo        Report: %RUN_DIR%\e2e\report\index.html
) ELSE (
    echo.
    echo [WARN] E2E Game Flow test exited with code %E2E_EXIT%
)
echo.

IF /I "%TEST_TYPE%"=="e2e" GOTO summary

:run_http
REM === Run HTTP Test ===
echo [%TIME%] Starting HTTP Health ^& Assets Test...
echo.

"%JMETER_CMD%" -n ^
    -t "%SCRIPT_DIR%skribbl_http_health.jmx" ^
    -JHOST=%HOST% ^
    -JPORT=%PORT% ^
    -JTHREADS=%HTTP_THREADS% ^
    -JRAMP_UP=%RAMP_UP% ^
    -JDURATION=%DURATION% ^
    -JTARGET_RPS=%TARGET_RPS% ^
    -l "%RUN_DIR%\http\results.jtl" ^
    -e -o "%RUN_DIR%\http\report"

SET HTTP_EXIT=%ERRORLEVEL%

IF %HTTP_EXIT% EQU 0 (
    echo.
    echo [PASS] HTTP test completed successfully.
    echo        Report: %RUN_DIR%\http\report\index.html
) ELSE (
    echo.
    echo [WARN] HTTP test exited with code %HTTP_EXIT%
)
echo.

:summary
echo ============================================================
echo   Test Run Complete
echo   Results Directory: %RUN_DIR%
echo.
IF /I NOT "%TEST_TYPE%"=="http" IF /I NOT "%TEST_TYPE%"=="e2e" (
    echo   WebSocket Report:  %RUN_DIR%\ws\report\index.html
)
IF /I "%TEST_TYPE%"=="e2e" (
    echo   E2E Game Report:   %RUN_DIR%\e2e\report\index.html
)
IF /I "%TEST_TYPE%"=="all" (
    echo   E2E Game Report:   %RUN_DIR%\e2e\report\index.html
)
IF /I NOT "%TEST_TYPE%"=="ws" IF /I NOT "%TEST_TYPE%"=="e2e" (
    echo   HTTP Report:       %RUN_DIR%\http\report\index.html
)
echo ============================================================
GOTO :eof

:show_help
echo.
echo Skribbl JMeter Performance Test Runner
echo.
echo Usage: run_test.bat [OPTIONS]
echo.
echo Options:
echo   --host HOST       Server hostname (default: localhost)
echo   --port PORT       Server port (default: 8000)
echo   --profile NAME    Test profile: smoke, load, stress, spike (default: smoke)
echo   --test TYPE       Test type: ws, http, e2e, all (default: ws)
echo   --help            Show this help
echo.
echo Profiles:
echo   smoke    Quick validation (2 rooms, 30s duration)
echo   load     Standard load test (10 rooms, 180s duration)
echo   stress   Stress test (25 rooms, 300s duration)
echo   spike    Spike test (50 rooms, 60s with rapid ramp)
echo   soak     Endurance test (20 rooms, 1 hour - detects memory leaks)
echo.
echo Examples:
echo   run_test.bat --profile load
echo   run_test.bat --host myapp.azurecontainerapps.io --port 443 --profile stress --test all
echo.
GOTO :eof
