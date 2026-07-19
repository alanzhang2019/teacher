$env:VOXCPM_MODEL_DIR = 'D:\AItrade\openmaic\OpenMAIC\ms-cache\models\openbmb--VoxCPM2\snapshots\master'
Set-Location D:\AItrade\openmaic\VoxCPM
& '.\.venv\Scripts\python.exe' .\test_volume_normalize.py
