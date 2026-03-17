param([Parameter(Mandatory)][string]$version)

# Update VERSION in main.py
(Get-Content main.py) -replace "VERSION = 'v[\d.]+'", "VERSION = 'v$version'" | Set-Content main.py

git add .
git commit -m "v$version"
git push
git tag "v$version"
git push --tags

Write-Host "Released v$version" -ForegroundColor Green