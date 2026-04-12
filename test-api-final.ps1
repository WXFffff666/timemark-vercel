$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIiwiZXhwIjoxNzc1ODM0ODE3fQ.GsL_RAsQYdOTRmCLZRwO9TIKSMVKIwlfodmQylXm8H8"
$headers = @{"Authorization" = "Bearer $token"}
$response = Invoke-WebRequest -Uri 'http://localhost:3000/api/auth/login-history' -Headers $headers -UseBasicParsing
Write-Host "Status:" $response.StatusCode
$json = $response.Content | ConvertFrom-Json
Write-Host "Count:" $json.data.Count
$json.data | Select-Object -First 3 | ForEach-Object { Write-Host "Time:" $_.login_time ", Success:" $_.success }