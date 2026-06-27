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

## Scaling with Multiple Replicas (Redis Pub/Sub)

To scale beyond a single replica, you need Azure Cache for Redis to synchronize broadcasts across workers.

### Step 1: Create Azure Cache for Redis
```bash
az redis create \
  --name skribbl-redis \
  --resource-group skribbl-rg \
  --location eastus \
  --sku Basic \
  --vm-size C0
```

### Step 2: Get the Redis Connection String
```bash
az redis show \
  --name skribbl-redis \
  --resource-group skribbl-rg \
  --query hostName \
  --output tsv

az redis list-keys \
  --name skribbl-redis \
  --resource-group skribbl-rg \
  --query primaryKey \
  --output tsv
```

### Step 3: Deploy with Redis and Multiple Replicas
```bash
az containerapp create \
  --name skribbl-app \
  --resource-group skribbl-rg \
  --environment skribbl-env \
  --image skribblacr.azurecr.io/skribbl-app:latest \
  --registry-server skribblacr.azurecr.io \
  --target-port 8000 \
  --ingress external \
  --min-replicas 2 \
  --max-replicas 4 \
  --cpu 1 \
  --memory 2Gi \
  --transport http \
  --env-vars "REDIS_URL=rediss://:<primaryKey>@skribbl-redis.redis.cache.windows.net:6380"
```

### Step 4: Enable Session Affinity
```bash
az containerapp ingress sticky-sessions set \
  --name skribbl-app \
  --resource-group skribbl-rg \
  --affinity sticky
```

> **Note:** Azure Container Apps session affinity uses the `worker_id` cookie set by the app.
> The `rediss://` scheme (with double s) enables TLS, required by Azure Cache for Redis.

### Cost with Redis
| Resource | Cost |
|----------|------|
| Container Apps (consumption, 2-4 vCPU) | ~$0.40–$0.80/day |
| Container Registry (Basic) | ~$5/month |
| Azure Cache for Redis (Basic C0) | ~$16/month |
| **Total** | **~$33–$45/month** |

## Alternative: Terraform
If you prefer IaC, see `infra/main.tf` for the equivalent Terraform configuration.
```bash
cd infra
terraform init
terraform apply
```
