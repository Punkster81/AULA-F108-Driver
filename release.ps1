param(
    [Parameter(Mandatory)][string]$version,
    [string]$message = ""
)

# Update VERSION in main.py
(Get-Content main.py) -replace "VERSION = 'v[\d.]+'", "VERSION = 'v$version'" | Set-Content main.py

$commitMsg = if ($message) { "v$version - $message" } else { "v$version" }

git add .
git commit -m $commitMsg
git push
git tag "v$version"
git push --tags

Write-Host "Released v$version" -ForegroundColor Green