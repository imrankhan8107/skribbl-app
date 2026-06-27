# Deploy to Azure Container Apps

## Prerequisites
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- [Docker](https://docs.docker.com/get-docker/) installed
- An Azure subscription

## Step 1: Login
```bash
az login
```

## Step 2: Create Resource Group
```bash
az group create --name skribbl-rg --location eastus
```

## Step 3: Create Container Registry
```bash
az acr create --resource-group skribbl-rg --name skribblacr --sku Basic
az acr login --name skribblacr
```

## Step 4: Build & Push Docker Image
```bash
docker build -t skribblacr.azurecr.io/skribbl-app:latest .
docker push skribblacr.azurecr.io/skribbl-app:latest
```

## Step 5: Create Container Apps Environment
```bash
az containerapp env create \
  --name skribbl-env \
  --resource-group skribbl-rg \
  --location eastus
```

## Step 6: Deploy the App
```bash
az containerapp create \
  --name skribbl-app \
  --resource-group skribbl-rg \
  --environment skribbl-env \
  --image skribblacr.azurecr.io/skribbl-app:latest \
  --registry-server skribblacr.azurecr.io \
  --target-port 8000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 1 \
  --cpu 1 \
  --memory 2Gi \
  --transport http
```

## Step 7: Get Your App URL
```bash
az containerapp show \
  --name skribbl-app \
  --resource-group skribbl-rg \
  --query properties.configuration.ingress.fqdn \
  --output tsv
```

Your app is live at: `https://<fqdn>`

## Updating the App
```bash
docker build -t skribblacr.azurecr.io/skribbl-app:latest .
docker push skribblacr.azurecr.io/skribbl-app:latest
az containerapp update \
  --name skribbl-app \
  --resource-group skribbl-rg \
  --image skribblacr.azurecr.io/skribbl-app:latest
```

## Tear Down
```bash
az group delete --name skribbl-rg --yes --no-wait
```

## Cost Estimate
| Resource | Cost |
|----------|------|
| Container Apps (consumption, 1 vCPU) | ~$0.20/day |
| Container Registry (Basic) | ~$5/month |
| **Total** | **~$11/month** |

## Notes
- **Single replica** (`--max-replicas 1`) — game state is in-memory; multiple replicas would break rooms
- **WebSocket** supported via `--transport http` on Container Apps
- **Heartbeat** (ping every 30s) keeps connections alive within Azure's idle timeout
- Terraform config is also available in `infra/main.tf` as an alternative

## Alternative: Terraform
If you prefer IaC, see `infra/main.tf` for the equivalent Terraform configuration.
```bash
cd infra
terraform init
terraform apply
```
