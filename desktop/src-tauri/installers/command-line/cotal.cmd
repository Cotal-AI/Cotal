@ECHO off
REM The cotal command of the Cotal desktop app: the app's bundled CLI on its own Node.
REM It lives in the installation's bin folder, so an update replaces it in place.
GOTO start
:find_root
REM The folder is read inside a called label: in the main body, a quoted name found on PATH can give the caller's folder.
FOR %%I IN ("%~dp0..") DO SET "root=%%~fI"
EXIT /b
:start
SETLOCAL
CALL :find_root
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%root%\node.exe" "%root%\runtime\dist\cotal.js" %*
