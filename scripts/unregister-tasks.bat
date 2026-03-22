@echo off
echo Unregistering turtle-gate scheduled tasks...
schtasks /Delete /TN "turtle-gate-paper" /F 2>nul && echo   turtle-gate-paper: removed || echo   turtle-gate-paper: not found
schtasks /Delete /TN "turtle-gate-review" /F 2>nul && echo   turtle-gate-review: removed || echo   turtle-gate-review: not found
echo Done.
pause
