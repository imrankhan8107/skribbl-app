# Deploy script for Azure App Service (no Docker required)
# Usage: .\deploy.ps1

Write-Host "Deploying Skribbl to Azure App Service..." -ForegroundColor Cyan

# Configuration
$RESOURCE_GROUP = "skribbl-rg"
$APP_NAME = "skribbl-game"
$PLAN_NAME = "skribbl-plan"
$LOCATION = "eastus"
$RUNTIME = "PYTHON:3.12"
$SKU = "B1"

# Step 1: Build frontend
Write-Host "`nStep 1: Building frontend..." -ForegroundColor Yellow
Push-Location frontend
npm install --silent
npm run build
Pop-Location

if (-not (Test-Path "frontend/dist/index.html")) {
    Write-Host "Frontend build failed" -ForegroundColor Red
    exit 1
}
Write-Host "Frontend built successfully" -ForegroundColor Green

# Disable error action for az commands (they write warnings to stderr)
$ErrorActionPreference = "Continue"

# Step 2: Create resource group
Write-Host "`nStep 2: Creating resource group..." -ForegroundColor Yellow
az group create --name $RESOURCE_GROUP --location $LOCATION --output none 2>$null
Start-Sleep -Seconds 3

# Step 3: Create App Service plan
Write-Host "Step 3: Creating App Service plan..." -ForegroundColor Yellow
az appservice plan create --name $PLAN_NAME --resource-group $RESOURCE_GROUP --sku $SKU --is-linux --output none 2>$null
Start-Sleep -Seconds 3

# Step 4: Create Web App
Write-Host "Step 4: Creating Web App..." -ForegroundColor Yellow
az webapp create --name $APP_NAME --resource-group $RESOURCE_GROUP --plan $PLAN_NAME --runtime $RUNTIME --output none 2>$null
Start-Sleep -Seconds 3

# Step 5: Configure
Write-Host "Step 5: Configuring WebSockets and startup..." -ForegroundColor Yellow
az webapp config set --name $APP_NAME --resource-group $RESOURCE_GROUP --web-sockets-enabled true --startup-file "pip install -r requirements.txt && uvicorn backend.main:app --host 0.0.0.0 --port 8000" --output none 2>$null

# Step 6: Create zip
Write-Host "Step 6: Creating deployment package..." -ForegroundColor Yellow
$ZIPFILE = "deploy.zip"
if (Test-Path $ZIPFILE) { Remove-Item $ZIPFILE }
Compress-Archive -Path "backend", "frontend/dist", "requirements.txt", "pytest.ini" -DestinationPath $ZIPFILE -Force

# Step 7: Deploy
Write-Host "Step 7: Deploying to Azure..." -ForegroundColor Yellow
az webapp deploy --name $APP_NAME --resource-group $RESOURCE_GROUP --src-path $ZIPFILE --type zip --output none 2>$null

Remove-Item $ZIPFILE -ErrorAction SilentlyContinue

# Step 8: Get URL
$FQDN = az webapp show --name $APP_NAME --resource-group $RESOURCE_GROUP --query "defaultHostName" --output tsv 2>$null
Write-Host "`nDeployed successfully!" -ForegroundColor Green
Write-Host "Your app is live at: https://$FQDN" -ForegroundColor Cyan
Write-Host "`nTo tear down: az group delete --name $RESOURCE_GROUP --yes --no-wait" -ForegroundColor DarkGray
