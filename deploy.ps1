# Deploy script for Azure App Service (no Docker required)
# Usage: .\deploy.ps1
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - Node.js 18+ (for frontend build)
#   - Python 3.12+

$ErrorActionPreference = "Stop"

Write-Host "🚀 Deploying Skribbl to Azure App Service..." -ForegroundColor Cyan

# Configuration — change these if needed
$RESOURCE_GROUP = "skribbl-rg"
$APP_NAME = "skribbl-game"
$PLAN_NAME = "skribbl-plan"
$LOCATION = "eastus"
$RUNTIME = "PYTHON:3.12"
$SKU = "B1"

# Step 1: Build frontend
Write-Host "`n📦 Step 1: Building frontend..." -ForegroundColor Yellow
Push-Location frontend
npm install --silent
npm run build
Pop-Location

if (-not (Test-Path "frontend/dist/index.html")) {
    Write-Host "❌ Frontend build failed - frontend/dist/index.html not found" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Frontend built successfully" -ForegroundColor Green

# Step 2: Create resource group
Write-Host "`n☁️  Step 2: Creating resource group..." -ForegroundColor Yellow
az group create --name $RESOURCE_GROUP --location $LOCATION
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Failed to create resource group" -ForegroundColor Red; exit 1 }

# Step 3: Create App Service plan
Write-Host "`n📋 Step 3: Creating App Service plan..." -ForegroundColor Yellow
az appservice plan create --name $PLAN_NAME --resource-group $RESOURCE_GROUP --sku $SKU --is-linux
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Failed to create plan" -ForegroundColor Red; exit 1 }

# Step 4: Create Web App
Write-Host "`n🌐 Step 4: Creating Web App..." -ForegroundColor Yellow
az webapp create --name $APP_NAME --resource-group $RESOURCE_GROUP --plan $PLAN_NAME --runtime $RUNTIME
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Failed to create web app" -ForegroundColor Red; exit 1 }

# Step 5: Configure WebSockets + startup command
Write-Host "`n⚙️  Step 5: Configuring app..." -ForegroundColor Yellow
az webapp config set --name $APP_NAME --resource-group $RESOURCE_GROUP --web-sockets-enabled true --startup-file "pip install -r requirements.txt && uvicorn backend.main:app --host 0.0.0.0 --port 8000"
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Failed to configure app" -ForegroundColor Red; exit 1 }

# Step 6: Create zip for deployment
Write-Host "`n📦 Step 6: Creating deployment package..." -ForegroundColor Yellow
$ZIPFILE = "deploy.zip"
if (Test-Path $ZIPFILE) { Remove-Item $ZIPFILE }

# Include only what's needed for production
Compress-Archive -Path @(
    "backend",
    "frontend/dist",
    "requirements.txt",
    "pytest.ini"
) -DestinationPath $ZIPFILE -Force

Write-Host "✅ Package created: $ZIPFILE" -ForegroundColor Green

# Step 7: Deploy the zip
Write-Host "`n📤 Step 7: Deploying to Azure..." -ForegroundColor Yellow
az webapp deploy --name $APP_NAME --resource-group $RESOURCE_GROUP --src-path $ZIPFILE --type zip
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Deployment failed" -ForegroundColor Red; exit 1 }

# Cleanup zip
Remove-Item $ZIPFILE

# Step 8: Get URL
$FQDN = az webapp show --name $APP_NAME --resource-group $RESOURCE_GROUP --query "defaultHostName" --output tsv
Write-Host "`n✅ Deployed successfully!" -ForegroundColor Green
Write-Host "🌐 Your app is live at: https://$FQDN" -ForegroundColor Cyan
Write-Host ""
Write-Host "To tear down:" -ForegroundColor DarkGray
Write-Host "  az group delete --name $RESOURCE_GROUP --yes --no-wait" -ForegroundColor DarkGray
