$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIiwiZXhwIjoxNzc1NDY1OTU3fQ.QoaZowtvD4kNuI9ozkWRPudeurDtnj2XxPe_bhNp1No"
$headers = @{"Authorization" = "Bearer $token"}
$response = Invoke-WebRequest -Uri 'http://localhost:3000/api/auth/login-history' -Headers $headers -UseBasicParsing
$response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10