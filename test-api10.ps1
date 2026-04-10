$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIiwiZXhwIjoxNzc1NDY4MjQ5fQ.md5SAfhW2Mg68ofIHW4CGDAMGpb9AY7lf0Dr5xASTzk"
$headers = @{"Authorization" = "Bearer $token"}
$response = Invoke-WebRequest -Uri 'http://localhost:3000/api/auth/login-history' -Headers $headers -UseBasicParsing
Write-Host "Status:" $response.StatusCode
$json = $response.Content | ConvertFrom-Json
Write-Host "Count:" $json.data.Count
$json.data | ForEach-Object { Write-Host "Time:" $_.login_time ", Success:" $_.success ", Username:" $_.username }