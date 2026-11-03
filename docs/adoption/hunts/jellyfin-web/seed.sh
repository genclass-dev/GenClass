#!/usr/bin/env bash
# Seeds a fresh local Jellyfin server for the jellyfin-web hunt (docs/adoption/hunts/jellyfin-web.md): completes the
# first-run wizard through the startup API (admin "hunt" / "hunt-local-pw"), adds a Movies library on
# /srv/jf/media/movies and waits for the scan. Local only; the credentials exist on this machine and nowhere else.
#   JF=http://127.0.0.1:8096 bash docs/adoption/hunts/jellyfin-web/seed.sh
set -euo pipefail
JF=${JF:-http://127.0.0.1:8096}
AUTH='MediaBrowser Client="hunt", Device="hunt", DeviceId="hunt-seed", Version="1.0.0"'
j() { curl -fsS -H "Content-Type: application/json" -H "Authorization: $AUTH${TOKEN:+, Token=\"$TOKEN\"}" "$@"; }
until curl -fsS "$JF/System/Info/Public" 2>/dev/null | grep -q StartupWizardCompleted; do sleep 1; done
sleep 3 # the API answers 503 for a moment after the public info is up
j -X POST "$JF/Startup/Configuration" -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
j "$JF/Startup/User" >/dev/null
j -X POST "$JF/Startup/User" -d '{"Name":"hunt","Password":"hunt-local-pw"}'
j -X POST "$JF/Startup/RemoteAccess" -d '{"EnableRemoteAccess":true}'
j -X POST "$JF/Startup/Complete"
TOKEN=$(j -X POST "$JF/Users/AuthenticateByName" -d '{"Username":"hunt","Pw":"hunt-local-pw"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessToken"])')
# no internet metadata: the library is local files only
j -X POST "$JF/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true&paths=%2Fsrv%2Fjf%2Fmedia%2Fmovies" \
  -d '{"LibraryOptions":{"EnableRealtimeMonitor":false,"MetadataSavers":[],"TypeOptions":[{"Type":"Movie","MetadataFetchers":[],"ImageFetchers":[]}]}}'
for _ in $(seq 1 120); do
  n=$(j "$JF/Items?Recursive=true&IncludeItemTypes=Movie&Limit=0" | python3 -c 'import json,sys;print(json.load(sys.stdin)["TotalRecordCount"])')
  [ "$n" -ge 30 ] && break; sleep 1
done
echo "movies: $n"
