# Print LAN-accessible URLs for phone devices on the same WiFi.

$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL" -and $_.IPAddress -notmatch "^169\." -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -ExpandProperty IPAddress

if (-not $ips) {
    Write-Host "  (Unable to detect LAN IP)" -ForegroundColor Red
    return
}

foreach ($ip in $ips) {
    Write-Host "  TV  : http://${ip}:3000/" -ForegroundColor Cyan
    Write-Host "  Phone scan QR on TV after creating a room." -ForegroundColor Gray
}
