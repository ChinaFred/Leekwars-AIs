@echo off
rem Lance LWGarden depuis la racine du depot, quel que soit le dossier courant.
pushd "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
	python LWGarden\src\Garden.py %*
) else (
	py LWGarden\src\Garden.py %*
)
set "GARDEN_EXIT=%errorlevel%"
popd
exit /b %GARDEN_EXIT%
