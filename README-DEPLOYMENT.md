# SSHSshje Dashboard Deployment Guide

## Overview
This guide explains how to deploy the SSHSshje dashboard to make it accessible to team members using Cloudflare Pages.

## Architecture
- **Frontend**: Next.js static export deployed to Cloudflare Pages
- **Backend**: FastAPI server (needs separate deployment)
- **Data Source**: Remote SSH server at 45.159.230.42:1511

## Deployment Steps

### 1. Backend Deployment (Required First)
The FastAPI backend needs to be deployed separately before the frontend:

#### Option A: Cloud Server (Recommended)
1. Deploy to a cloud server (DigitalOcean, AWS, etc.)
2. Install dependencies: `pip install fastapi uvicorn paramiko psutil python-dotenv`
3. Set environment variables:
   ```bash
   export SSH_HOST=45.159.230.42
   export SSH_PORT=1511
   export SSH_USERNAME=root
   export REMOTE_HOST=45.159.230.42
   ```
4. Run with: `uvicorn sshsshje_api:app --host 0.0.0.0 --port 8000`
5. Configure nginx reverse proxy with SSL

#### Option B: Cloudflare Workers (Alternative)
Deploy the FastAPI backend as Cloudflare Workers using `wrangler`

### 2. Frontend Deployment (Cloudflare Pages)

#### Prerequisites
1. GitHub account with this repository
2. Cloudflare account
3. Backend API deployed and accessible

#### Setup Cloudflare Pages
1. Go to [Cloudflare Pages](https://pages.cloudflare.com/)
2. Connect your GitHub repository
3. Configure build settings:
   - **Build command**: `npm run build:static`
   - **Output directory**: `out`
   - **Environment variables**:
     - `NEXT_PUBLIC_AGENT_BASE`: `https://your-api-backend.com`
     - `NEXT_PUBLIC_AGENT_WS`: `wss://your-api-backend.com/ws`

#### GitHub Secrets Setup
Add these secrets to your GitHub repository:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
- `NEXT_PUBLIC_AGENT_BASE`: Your backend API URL
- `NEXT_PUBLIC_AGENT_WS`: Your backend WebSocket URL

#### GitHub Actions (Automatic)
The GitHub Actions workflow will automatically:
1. Build the Next.js application
2. Deploy to Cloudflare Pages on every push to main

### 3. Security Configuration

#### Backend Security
- Add API authentication (JWT tokens or API keys)
- Configure CORS for your frontend domain
- Use environment variables for SSH credentials
- Set up rate limiting

#### Frontend Security
- Configure CSP headers
- Use HTTPS only
- Implement authentication if needed

### 4. Custom Domain (Optional)
1. Add your domain to Cloudflare Pages
2. Configure DNS records
3. Enable SSL/TLS encryption

## Environment Variables Reference

### Backend (FastAPI)
```env
SSH_HOST=45.159.230.42
SSH_PORT=1511
SSH_USERNAME=root
SSH_KEY_PATH=/path/to/ssh/key
REMOTE_HOST=45.159.230.42
API_PORT=3001
```

### Frontend (Next.js)
```env
NEXT_PUBLIC_AGENT_BASE=https://your-api-backend.com
NEXT_PUBLIC_AGENT_WS=wss://your-api-backend.com/ws
```

## Testing Deployment

### Local Testing
1. Build production version: `npm run build:static`
2. Serve static files: `npx serve out`
3. Test with production API endpoints

### Production Testing
1. Check API endpoints are accessible
2. Verify WebSocket connections work
3. Test all dashboard features
4. Monitor for errors in browser console

## Troubleshooting

### Common Issues
1. **CORS errors**: Configure backend CORS for frontend domain
2. **WebSocket failures**: Check WSS protocol and certificates
3. **API timeouts**: Verify backend is accessible and SSH connections work
4. **Build failures**: Check Node.js version and dependencies

### Monitoring
- Set up uptime monitoring for both frontend and backend
- Configure error logging and alerting
- Monitor API response times and SSH connection health

## Alternative Deployment Options

### 1. Self-hosted (Single Server)
Deploy both frontend and backend on same server with nginx reverse proxy

### 2. Vercel (Frontend) + Railway/Render (Backend)
Use Vercel for frontend and Railway/Render for backend deployment

### 3. Docker Deployment
Containerize both applications for easier deployment and scaling

## Security Considerations
- Never commit SSH keys or credentials to repository
- Use secure environment variable management
- Implement proper authentication for production access
- Regular security updates and monitoring
- Network segmentation and firewall configuration