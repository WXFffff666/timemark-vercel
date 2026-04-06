$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIiwiZXhwIjoxNzc1NDY2OTMxfQ.gPABZ_Y0XM-eqcTJul68ubiQ1pd_boiUZWdiqtd4jA0"
$headers = @{"Authorization" = "Bearer $token"}
$response = Invoke-WebRequest -Uri 'http://localhost:3000/api/auth/login-history' -Headers $headers -UseBasicParsing -TimeoutSec 10
Write-Host "Status:" $response.StatusCode
$json = $response.Content | ConvertFrom-Json
Write-Host "Total records:" $json.data.Count
$json.data | ForEach-Object { Write-Host "Time:" $_.login_time ", Success:" $_.success ", Username:" $_.username }