@echo off
rem PLATEAU Viewer 起動スクリプト（Windows）
cd /d %~dp0
if exist .venv\Scripts\activate.bat call .venv\Scripts\activate.bat
python plateau_viewer.py %*
