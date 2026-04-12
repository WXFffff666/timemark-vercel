$body = @{
    username = "admin"
    password = "TimeMark@2026"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri 'http://localhost:3000/api/auth/login' -Method POST -Body $body -ContentType 'application/json'
$token = $response.data.accessToken
Write-Host "Token: $token"

# Get login history
$history = Invoke-RestMethod -Uri 'http://localhost:3000/api/auth/login-history' -Method GET -Header @{'Authorization'="Bearer $token"}
$history | ConvertTo-Json -Depth 10