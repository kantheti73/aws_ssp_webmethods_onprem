<#
.SYNOPSIS
  Publishes the on-prem Orders API definition + JWT policy to webMethods API Gateway.

.DESCRIPTION
  Idempotent: if the API exists, it is updated; otherwise created. Policy is attached
  globally before the API is activated so no request slips through without JWT validation.

.EXAMPLE
  $cred = Get-Credential
  .\deploy-api.ps1 -GatewayUrl https://wm-apigw.internal:5555 -Credential $cred

.NOTES
  Run from a host with network access to the webMethods APIGW admin endpoint.
  Service account should have role: "API Provider".
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $GatewayUrl,
  [Parameter(Mandatory)] [pscredential] $Credential,
  [string] $ApiDefinitionPath = "$PSScriptRoot\api-definition-orders.json",
  [string] $PolicyPath        = "$PSScriptRoot\jwt-policy.json"
)

$ErrorActionPreference = 'Stop'

function Invoke-Wm {
  param([string]$Method, [string]$Path, $Body)
  $uri = "$GatewayUrl/rest/apigateway$Path"
  $params = @{
    Method      = $Method
    Uri         = $uri
    Credential  = $Credential
    ContentType = 'application/json'
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 20)
  }
  Invoke-RestMethod @params
}

Write-Host "1/4 Reading definitions..." -ForegroundColor Cyan
$apiDef  = Get-Content $ApiDefinitionPath -Raw | ConvertFrom-Json
$policy  = Get-Content $PolicyPath        -Raw | ConvertFrom-Json
$apiName = $apiDef.apiDefinition.apiName

Write-Host "2/4 Ensuring JWT policy exists..." -ForegroundColor Cyan
try {
  $existingPolicy = Invoke-Wm GET "/policies?name=$($policy.policyName)"
  if ($existingPolicy -and $existingPolicy.policies) {
    Write-Host "  -> updating $($policy.policyName)"
    Invoke-Wm PUT "/policies/$($policy.policyName)" $policy | Out-Null
  } else {
    Write-Host "  -> creating $($policy.policyName)"
    Invoke-Wm POST "/policies" $policy | Out-Null
  }
} catch {
  Write-Warning "Policy lookup failed; attempting create. ($_)"
  Invoke-Wm POST "/policies" $policy | Out-Null
}

Write-Host "3/4 Publishing API '$apiName'..." -ForegroundColor Cyan
try {
  $existing = Invoke-Wm GET "/apis?apiName=$apiName"
  if ($existing -and $existing.apis) {
    $apiId = $existing.apis[0].id
    Write-Host "  -> updating existing API id=$apiId"
    Invoke-Wm PUT "/apis/$apiId" $apiDef | Out-Null
  } else {
    Write-Host "  -> creating new API"
    $created = Invoke-Wm POST "/apis" $apiDef
    $apiId = $created.api.id
  }
} catch {
  throw "API publish failed: $_"
}

Write-Host "4/4 Activating API..." -ForegroundColor Cyan
Invoke-Wm PUT "/apis/$apiId/activate" $null | Out-Null

Write-Host ""
Write-Host "Done. API '$apiName' (id=$apiId) is active on $GatewayUrl." -ForegroundColor Green
