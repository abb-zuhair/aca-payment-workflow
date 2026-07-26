#!/bin/bash
set -e
cd "$(dirname "$0")"
rm -rf data/payments.db data/payments.db-* data/uploads/* 2>/dev/null || true

ADMIN_PASSWORD='Aca@Admin2026' PORT=3456 node server.js > server.log 2>&1 &
SERVER_PID=$!
# wait until the server answers before starting tests
for i in $(seq 1 30); do
  curl -s --noproxy '*' -o /dev/null http://localhost:3456/ && break
  sleep 0.3
done

B=http://localhost:3456/api
J=/tmp/jars; rm -rf $J; mkdir -p $J
req(){ jar=$1; shift; curl -s --noproxy '*' -b "$J/$jar" -c "$J/$jar" "$@"; }
pyget(){ python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

PASS=0; FAIL=0
check(){ if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "  ✓ $3"; else FAIL=$((FAIL+1)); echo "  ✗ $3 (expected [$2], got [$1])"; fi }

echo "== Admin login =="
R=$(req admin -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"admin","password":"Aca@Admin2026"}')
check "$(echo $R | pyget "print(d['user']['role'])")" "admin" "admin logs in"

echo "== Wrong password rejected =="
R=$(req bad -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"admin","password":"wrong"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "bad password rejected"

echo "== Create users =="
for u in '{"name":"Zuhair","role":"requestor","password":"Test12345"}' \
         '{"name":"Layla","role":"supervisor","password":"Test12345"}' \
         '{"name":"Fatima","role":"accountant","password":"Test12345"}' \
         '{"name":"Omar","role":"accountant","password":"Test12345"}' \
         '{"name":"Ahmed","role":"budget","password":"Test12345"}' \
         '{"name":"Sara","role":"budget","password":"Test12345"}' \
         '{"name":"Nadia","role":"finance","password":"Test12345"}'; do
  req admin -X POST $B/users -H 'Content-Type: application/json' -d "$u" > /dev/null
done
N=$(req admin $B/users | pyget "print(len(d['users']))")
check "$N" "8" "8 accounts exist (admin + 7)"

echo "== Weak password refused =="
R=$(req admin -X POST $B/users -H 'Content-Type: application/json' -d '{"name":"Weak","role":"requestor","password":"123"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "short password refused"

echo "== Routing: Zuhair -> Layla (supervisor) + Fatima (accountant) =="
ZID=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Zuhair'][0])")
LID=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Layla'][0])")
FID=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Fatima'][0])")
req admin -X PUT $B/routing -H 'Content-Type: application/json' -d "{\"routing\":[{\"requestorId\":\"$ZID\",\"supervisor\":\"u:$LID\",\"accountant\":\"u:$FID\"}]}" > /dev/null
check "$(req admin $B/routing | pyget "print(d['routing'][0]['accountant']==\"u:$FID\")")" "True" "routing saved (u: prefix)"

echo "== Requestor login forces password change flag =="
R=$(req zuhair -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Zuhair","password":"Test12345"}')
check "$(echo $R | pyget "print(d['user']['mustChangePassword'])")" "True" "mustChangePassword set"
req zuhair -X POST $B/change-password -H 'Content-Type: application/json' -d '{"currentPassword":"Test12345","newPassword":"MyOwnPass99"}' > /dev/null
R=$(req zuhair $B/me)
check "$(echo $R | pyget "print(d['user']['mustChangePassword'])")" "False" "password changed"

echo "== Submit request with a PDF and an image attachment =="
printf '%%PDF-1.4 fake invoice for test\n%%%%EOF' > /tmp/invoice.pdf
python3 -c "
from PIL import Image
img = Image.new('RGB',(400,200),(200,220,240))
img.save('/tmp/receipt.png')" 2>/dev/null || printf '\x89PNG\r\n\x1a\n' > /tmp/receipt.png
R=$(req zuhair -X POST $B/requests \
  -F department=IT -F payeeName=MOC -F payeeAddress=Kuwait \
  -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque \
  -F amount=450 -F currency=KWD -F 'description=ACAH-CON 50 — Move ISDN to new vendor' \
  -F 'documents=["Invoice 360246"]' \
  -F files=@/tmp/invoice.pdf -F files=@/tmp/receipt.png)
RID=$(echo $R | pyget "print(d['request']['id'])")
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_supervisor" "request created -> pending_supervisor"
check "$(echo $R | pyget "print(len(d['request']['attachments']))")" "2" "2 attachments stored"
check "$(echo $R | pyget "print(d['request']['assigned']['supervisor']['name'])")" "Layla" "routed to Layla (supervisor)"
check "$(echo $R | pyget "print(d['request']['assigned']['accountant']['name'])")" "Fatima" "routed to Fatima (accountant)"

echo "== Bank transfer without currency refused =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=X -F 'paymentType=Supplier Payment' -F 'paymentMethod=Bank Transfer' -F amount=100 -F currency= -F description=test)
check "$(echo $R | pyget "print('error' in d)")" "True" "currency required for bank transfer"

echo "== Fatima tries to act while still at supervisor stage (blocked) =="
req fatima -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Fatima","password":"Test12345"}' > /dev/null
R=$(req fatima -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "accountant blocked while pending_supervisor"

echo "== Wrong supervisor login (no other supervisor exists, so test via Omar's role mismatch) =="
req omar -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Omar","password":"Test12345"}' > /dev/null
R=$(req omar -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "accountant role cannot act at supervisor stage"

echo "== Requestor cannot approve at all =="
R=$(req zuhair -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "requestor cannot decide"

echo "== Layla (assigned supervisor) approves =="
req layla -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Layla","password":"Test12345"}' > /dev/null
R=$(req layla -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Reviewed and endorsed"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_accountant" "advanced to accountant"

echo "== Wrong accountant (Omar) blocked by routing =="
R=$(req omar -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('Fatima' in d.get('error',''))")" "True" "Omar blocked (assigned to Fatima)"

echo "== Budget supervisor cannot approve out of turn =="
req ahmed -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Ahmed","password":"Test12345"}' > /dev/null
R=$(req ahmed -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "budget blocked at accountant stage"

echo "== Requestor cannot approve at all =="
R=$(req zuhair -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "requestor cannot decide (again)"

echo "== Fatima (assigned accountant) approves with finance numbers =="
R=$(req fatima -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Invoice verified","financeUse":{"requestNo":"REQ-0001","voucherNo":"V-778","vendorNo":"VEN-12"}}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_budget" "advanced to budget"
check "$(echo $R | pyget "print(d['request']['financeUse']['requestNo'])")" "REQ-0001" "finance numbers recorded"

echo "== Double-approval race blocked =="
R=$(req fatima -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "second accountant approval refused"

echo "== Ahmed (budget) approves =="
R=$(req ahmed -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Within budget"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_finance" "advanced to finance"

echo "== Rejection without reason refused =="
req nadia -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Nadia","password":"Test12345"}' > /dev/null
R=$(req nadia -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"rejected","comment":""}')
check "$(echo $R | pyget "print('error' in d)")" "True" "reject needs a reason"

echo "== Nadia (finance) gives final approval =="
R=$(req nadia -X POST $B/requests/$RID/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Approved for payment"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "approved" "fully APPROVED"
check "$(echo $R | pyget "print('completedAt' in d['request'])")" "True" "completion timestamp recorded"
check "$(echo $R | pyget "print(any('ALL APPROVALS COMPLETE' in l['action'] for l in d['request']['log']))")" "True" "'ALL APPROVALS COMPLETE' logged"

echo "== Accountant can fetch attachment (for print) =="
AID=$(req fatima $B/requests | pyget "print([r for r in d['requests'] if r['id']=='$RID'][0]['attachments'][0]['id'])")
CODE=$(req fatima -o /dev/null -w '%{http_code}' $B/files/$AID)
check "$CODE" "200" "attachment downloads for accountant"

echo "== Unauthenticated access blocked =="
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/requests)
check "$CODE" "401" "API requires login"
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/files/$AID)
check "$CODE" "401" "files require login"

echo "== Requestor sees only own requests =="
req admin -X POST $B/users -H 'Content-Type: application/json' -d '{"name":"OtherReq","role":"requestor","password":"Test12345"}' > /dev/null
req other -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"OtherReq","password":"Test12345"}' > /dev/null
N=$(req other $B/requests | pyget "print(len(d['requests']))")
check "$N" "0" "other requestor sees 0 requests"

echo "== Threshold workflow: finance only >= 1000 =="
req admin -X PUT $B/workflow -H 'Content-Type: application/json' -d '{"workflow":[{"key":"accountant","enabled":true,"minAmount":0},{"key":"budget","enabled":true,"minAmount":0},{"key":"finance","enabled":true,"minAmount":1000}]}' > /dev/null
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=SmallVendor -F 'paymentType=Petty Cash' -F paymentMethod=Cheque -F amount=200 -F currency=KWD -F 'description=Small purchase')
check "$(echo $R | pyget "print(d['request']['chain'])")" "['accountant', 'budget']" "200 KWD skips finance stage"
RID2=$(echo $R | pyget "print(d['request']['id'])")
req fatima -X POST $B/requests/$RID2/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req ahmed -X POST $B/requests/$RID2/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "approved" "2-stage chain completes as approved"

echo "== Deactivated user blocked =="
OID=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Omar'][0])")
req admin -X PATCH $B/users/$OID -H 'Content-Type: application/json' -d '{"active":false}' > /dev/null
R=$(req omar2 -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Omar","password":"Test12345"}')
check "$(echo $R | pyget "print('deactivated' in d.get('error',''))")" "True" "deactivated login blocked"

echo "== Audit log populated =="
N=$(req admin $B/audit | pyget "print(len(d['audit'])>10)")
check "$N" "True" "audit entries recorded"

echo "== Email notifications logged (unconfigured -> skipped but recorded) =="
N=$(req admin $B/audit | pyget "print(sum(1 for a in d['audit'] if 'Email skipped' in a['action'])>0)")
check "$N" "True" "email attempts recorded in audit"
N=$(req admin $B/audit | pyget "print(any('ALL APPROVALS COMPLETE' not in a['action'] and 'Action needed' in a['action'] for a in d['audit']))")
check "$N" "True" "stage-change notification composed"
N=$(req admin $B/audit | pyget "print(any('[Approved]' in a['action'] for a in d['audit']))")
check "$N" "True" "final-approval notification composed"

echo "== Excel export =="
req admin -o /tmp/export.xlsx -w '' $B/export.xlsx
CODE=$(req admin -o /dev/null -w '%{http_code}' $B/export.xlsx)
check "$CODE" "200" "export endpoint returns 200"
python3 - <<'PYEOF'
import openpyxl
wb = openpyxl.load_workbook('/tmp/export.xlsx')
ws = wb['Payment Requests']
rows = list(ws.iter_rows(values_only=True))
assert rows[0][0] == 'Reference', 'header row'
assert len(rows) >= 3, 'expected >=2 data rows, got %d' % (len(rows)-1)
ids = [r[0] for r in rows[1:]]
assert all(str(i).startswith('ACA-') for i in ids), 'ids present'
statuses = [r[2] for r in rows[1:]]
assert 'Approved' in statuses, 'approved status present'
amounts = [r[8] for r in rows[1:]]
assert any(isinstance(a,(int,float)) and a==450 for a in amounts), '450 amount as number'
print('  xlsx-parse OK: %d data rows, statuses %s' % (len(rows)-1, sorted(set(statuses))))
PYEOF
check "$?" "0" "xlsx parses with correct data"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' $B/export.xlsx)
check "$CODE" "403" "requestor cannot export"
CODE=$(req fatima -o /dev/null -w '%{http_code}' $B/export.xlsx)
check "$CODE" "200" "accountant can export"

echo "== Reset workflow to all 4 stages (undo threshold test) =="
req admin -X PUT $B/workflow -H 'Content-Type: application/json' -d '{"workflow":[{"key":"supervisor","enabled":true,"minAmount":0},{"key":"accountant","enabled":true,"minAmount":0},{"key":"budget","enabled":true,"minAmount":0},{"key":"finance","enabled":true,"minAmount":0}]}' > /dev/null
C=$(req admin $B/workflow | pyget "print(len(d['workflow']))")
check "$C" "4" "workflow has 4 stages incl. supervisor"

echo "== Teams: create Budget Committee (policy=all, parallel) =="
req admin -X POST $B/users -H 'Content-Type: application/json' -d '{"name":"Khalid","role":"budget","password":"Test12345"}' > /dev/null
GR=$(req admin -X POST $B/groups -H 'Content-Type: application/json' -d '{"name":"Budget Committee","role":"budget","policy":"all"}')
GID=$(echo $GR | pyget "print(d['group']['id'])")
check "$(echo $GR | pyget "print(d['group']['policy'])")" "all" "team created with parallel policy"
AID2=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Ahmed'][0])")
SID=$(req admin $B/users | pyget "print([u['id'] for u in d['users'] if u['name']=='Sara'][0])")
req admin -X POST $B/groups/$GID/members -H 'Content-Type: application/json' -d "{\"userId\":\"$AID2\"}" > /dev/null
R=$(req admin -X POST $B/groups/$GID/members -H 'Content-Type: application/json' -d "{\"userId\":\"$SID\"}")
check "$(echo $R | pyget "print(len(d['group']['members']))")" "2" "team has 2 members (Ahmed, Sara)"

echo "== Route Zuhair's budget stage to the team =="
req admin -X PUT $B/routing -H 'Content-Type: application/json' -d "{\"routing\":[{\"requestorId\":\"$ZID\",\"supervisor\":\"u:$LID\",\"accountant\":\"u:$FID\",\"budget\":\"g:$GID\"}]}" > /dev/null

echo "== Submit request #3, walk to budget team stage =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=TeamTestVendor -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=300 -F currency=KWD -F 'description=Team parallel approval test')
RID3=$(echo $R | pyget "print(d['request']['id'])")
check "$(echo $R | pyget "print(d['request']['assigned']['budget']['type'])")" "group" "budget stage assigned to a team"
req layla -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req fatima $B/requests | pyget "print([r for r in d['requests'] if r['id']=='$RID3'][0]['status'])")
check "$R" "pending_budget" "request reached team budget stage"

echo "== Khalid (budget role, not on team) blocked =="
req khalid -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Khalid","password":"Test12345"}' > /dev/null
R=$(req khalid -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('not a member' in d.get('error',''))")" "True" "non-member blocked from team stage"

echo "== Ahmed (team member) approves — 1 of 2, stage not complete =="
R=$(req ahmed -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Looks fine"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_budget" "still pending_budget after 1st team vote"
check "$(echo $R | pyget "print(len(d['request']['approvals']['budget']['votes']))")" "1" "1 vote recorded"

echo "== Ahmed cannot vote twice =="
R=$(req ahmed -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$(echo $R | pyget "print('already voted' in d.get('error',''))")" "True" "duplicate team vote blocked"

echo "== Sara (2nd team member) approves — stage completes, advances to finance =="
req sara -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Sara","password":"Test12345"}' > /dev/null
R=$(req sara -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Agreed"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_finance" "team stage complete -> advanced to finance"
check "$(echo $R | pyget "print(any('stage complete' in l['action'] for l in d['request']['log']))")" "True" "'stage complete' logged for team"

echo "== Nadia gives final approval on team-routed request =="
R=$(req nadia -X POST $B/requests/$RID3/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Final"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "approved" "request #3 fully approved via team"

echo "== Teams: parallel rejection by one member rejects the whole stage =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=RejectTestVendor -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=250 -F currency=KWD -F description=test)
RID4=$(echo $R | pyget "print(d['request']['id'])")
req layla -X POST $B/requests/$RID4/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RID4/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req ahmed -X POST $B/requests/$RID4/decision -H 'Content-Type: application/json' -d '{"decision":"rejected","comment":"Over budget for this quarter"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "rejected" "single team rejection rejects the whole request"
check "$(echo $R | pyget "print('Budget Committee' in d['request']['rejectedStage'])")" "True" "rejected stage names the team"

echo "== Print form settings: defaults, update, persist =="
R=$(req admin $B/print-settings)
check "$(echo $R | pyget "print(d['print']['orgName'])")" "Sama Educational Co." "default org name"
req admin -X PUT $B/print-settings -H 'Content-Type: application/json' -d '{"print":{"orgName":"ACA Test Co.","logoInitial":"A","formTitle":"CUSTOM PAYMENT FORM","headerNote":"Finance Dept Only","showApprovals":true,"showAttachments":false,"showBanner":true,"footerLine":"Sign here please","signatoryLabel":"Finance Director","footerNote":"Keep for records"}}' > /dev/null
R=$(req fatima $B/print-settings)
check "$(echo $R | pyget "print(d['print']['orgName'])")" "ACA Test Co." "print settings updated and visible to other roles"
check "$(echo $R | pyget "print(d['print']['showAttachments'])")" "False" "boolean toggle persisted"
R=$(req admin -X PUT $B/print-settings -H 'Content-Type: application/json' -d '{"print":{"orgName":""}}')
check "$(echo $R | pyget "print('error' in d)")" "True" "empty org name rejected"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X PUT $B/print-settings -H 'Content-Type: application/json' -d '{"print":{"orgName":"Hack"}}')
check "$CODE" "403" "non-admin cannot change print settings"

echo "== Print layout: default merge includes every standard field =="
R=$(req admin $B/print-layout)
N=$(echo $R | pyget "print(sum(1 for b in d['layout'] if b['kind']=='standard'))")
check "$N" "16" "all 16 standard fields present by default"
check "$(echo $R | pyget "print(d['layout'][0]['sourceKey'])")" "department" "default order starts with department"

echo "== Print layout: hide a field, reorder, add header + static text, save =="
R=$(req admin $B/print-layout)
python3 - "$R" > /tmp/layout_edit.json <<'PYEOF'
import json,sys
d = json.loads(sys.argv[1])
layout = d['layout']
# hide requestorPhone
for b in layout:
    if b.get('sourceKey') == 'requestorPhone':
        b['visible'] = False
# move first item (department) to the end
first = layout.pop(0)
layout.append(first)
# add a section header and a static disclaimer row
layout.append({"id":"hdr_test","kind":"header","label":"Internal Use","visible":True})
layout.append({"id":"txt_test","kind":"static","label":"Disclaimer","staticText":"Approved per Board Resolution 45","visible":True})
print(json.dumps({"layout": layout}))
PYEOF
req admin -X PUT $B/print-layout -H 'Content-Type: application/json' --data-binary @/tmp/layout_edit.json > /dev/null
R=$(req admin $B/print-layout)
check "$(echo $R | pyget "print([b for b in d['layout'] if b.get('sourceKey')=='requestorPhone'][0]['visible'])")" "False" "hidden field stays hidden after save"
check "$(echo $R | pyget "print(d['layout'][-3]['sourceKey'])")" "department" "reordered field moved to new position"
check "$(echo $R | pyget "print(any(b['kind']=='header' and b['label']=='Internal Use' for b in d['layout']))")" "True" "section header saved"
check "$(echo $R | pyget "print(any(b['kind']=='static' and b['staticText']=='Approved per Board Resolution 45' for b in d['layout']))")" "True" "static text row saved"

echo "== Print layout: newly added custom field auto-appears in layout =="
R=$(req admin -X POST $B/custom-fields -H 'Content-Type: application/json' -d '{"label":"Extra Field For Layout Test","type":"text","required":false}')
NEWCFID=$(echo $R | pyget "print(d['fields'][-1]['id'])")
R=$(req admin $B/print-layout)
check "$(echo $R | pyget "print(any(b['kind']=='custom' and b['sourceKey']=='$NEWCFID' for b in d['layout']))")" "True" "new custom field auto-added to layout"

echo "== Print layout validation =="
R=$(req admin -X PUT $B/print-layout -H 'Content-Type: application/json' -d '{"layout":[{"kind":"bogus","label":"x","visible":true}]}')
check "$(echo $R | pyget "print('error' in d)")" "True" "invalid block kind rejected"
R=$(req admin -X PUT $B/print-layout -H 'Content-Type: application/json' -d '{"layout":[{"kind":"static","label":"","visible":true}]}')
check "$(echo $R | pyget "print('error' in d)")" "True" "empty label rejected"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X PUT $B/print-layout -H 'Content-Type: application/json' -d '{"layout":[]}')
check "$CODE" "403" "non-admin cannot save layout"

echo "== Reset layout to default (empty save) rebuilds from standard fields =="
req admin -X PUT $B/print-layout -H 'Content-Type: application/json' -d '{"layout":[]}' > /dev/null
R=$(req admin $B/print-layout)
check "$(echo $R | pyget "print(d['layout'][0]['sourceKey'])")" "department" "reset restores default order"
check "$(echo $R | pyget "print(all(b['visible'] for b in d['layout'] if b['kind'] in ('standard','custom')))")" "True" "reset restores full visibility"

echo "== Custom fields: create text (required), select, and unused number field =="
BASE_COUNT=$(req admin $B/custom-fields | pyget "print(len(d['fields']))")
R=$(req admin -X POST $B/custom-fields -H 'Content-Type: application/json' -d '{"label":"Cost Center Code","type":"text","required":true,"placeholder":"e.g. CC-1042"}')
check "$(echo $R | pyget "print(len(d['fields']))")" "$((BASE_COUNT+1))" "text field created"
CFID1=$(echo $R | pyget "print([f['id'] for f in d['fields'] if f['label']=='Cost Center Code'][0])")
R=$(req admin -X POST $B/custom-fields -H 'Content-Type: application/json' -d '{"label":"Project","type":"select","required":false,"options":"Renovation, Curriculum, IT Infrastructure"}')
check "$(echo $R | pyget "print(len([f for f in d['fields'] if f['label']=='Project'][0]['options']))")" "3" "select field with 3 options"
CFID2=$(echo $R | pyget "print([f['id'] for f in d['fields'] if f['label']=='Project'][0])")
R=$(req admin -X POST $B/custom-fields -H 'Content-Type: application/json' -d '{"label":"Bad Dropdown","type":"select","options":"OnlyOne"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "dropdown needs >=2 options"
R=$(req zuhair -X POST $B/custom-fields -H 'Content-Type: application/json' -d '{"label":"Hack","type":"text"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "non-admin cannot add fields"

echo "== Submit request missing required custom field -> rejected =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=FieldTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=120 -F currency=KWD -F description=test -F 'customFieldValues={}')
check "$(echo $R | pyget "print('Cost Center Code' in d.get('error',''))")" "True" "missing required custom field rejected"

echo "== Submit request with valid custom field values =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=FieldTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=120 -F currency=KWD -F description=test \
  -F "customFieldValues={\"$CFID1\":\"CC-9911\",\"$CFID2\":\"IT Infrastructure\"}")
RID5=$(echo $R | pyget "print(d['request']['id'])")
check "$(echo $R | pyget "print([f['value'] for f in d['request']['customFields'] if f['label']=='Cost Center Code'][0])")" "CC-9911" "custom text value frozen on request"
check "$(echo $R | pyget "print([f['value'] for f in d['request']['customFields'] if f['label']=='Project'][0])")" "IT Infrastructure" "custom select value frozen on request"

echo "== Invalid dropdown value rejected =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=FieldTest2 -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=80 -F currency=KWD -F description=test \
  -F "customFieldValues={\"$CFID1\":\"CC-1\",\"$CFID2\":\"NotARealOption\"}")
check "$(echo $R | pyget "print('error' in d)")" "True" "invalid select value rejected"

echo "== Deleting a field doesn't erase values already on past requests =="
req admin -X DELETE $B/custom-fields/$CFID2 > /dev/null
N=$(req admin $B/custom-fields | pyget "print(len(d['fields']))")
check "$N" "$((BASE_COUNT+1))" "field removed from active config"
R=$(req fatima $B/requests | pyget "print(len([f for f in [r for r in d['requests'] if r['id']=='$RID5'][0]['customFields'] if f['label']=='Project']))")
check "$R" "1" "deleted field's value still present on the old request"

echo "== Excel export includes Custom Fields column =="
req admin -o /tmp/export2.xlsx -w '' $B/export.xlsx
python3 - <<'PYEOF'
import openpyxl
wb = openpyxl.load_workbook('/tmp/export2.xlsx')
ws = wb['Payment Requests']
rows = list(ws.iter_rows(values_only=True))
header = rows[0]
assert 'Custom Fields' in header, 'Custom Fields column present'
idx = header.index('Custom Fields')
values = [r[idx] for r in rows[1:] if r[idx]]
assert any('Cost Center Code: CC-9911' in v for v in values), 'custom field value in export'
print('  custom-fields export OK:', [v for v in values if v][:1])
PYEOF
check "$?" "0" "custom fields column present in export"

echo "== Branding: default has no logo =="
R=$(curl -s --noproxy '*' $B/branding)
check "$(echo $R | pyget "print(d['hasLogo'])")" "False" "no logo by default"
check "$(echo $R | pyget "print(d['orgName'])")" "ACA Test Co." "branding reflects earlier org-name change"

echo "== Logo upload: valid PNG accepted, served back, then removed =="
python3 -c "
from PIL import Image
Image.new('RGB',(64,64),(30,60,90)).save('/tmp/logo.png')" 2>/dev/null || printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' > /tmp/logo.png
CODE=$(req admin -o /dev/null -w '%{http_code}' -X POST $B/logo -F logo=@/tmp/logo.png)
check "$CODE" "200" "logo upload accepted"
R=$(curl -s --noproxy '*' $B/branding)
check "$(echo $R | pyget "print(d['hasLogo'])")" "True" "branding reports hasLogo after upload"
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/logo)
check "$CODE" "200" "logo file downloads publicly (unauthenticated, for login screen)"

echo "== Logo upload rejects bad file type =="
echo "not an image" > /tmp/notimage.txt
R=$(req admin -X POST $B/logo -F logo=@/tmp/notimage.txt)
check "$(echo $R | pyget "print('error' in d)")" "True" "non-image logo upload rejected"

echo "== Non-admin cannot upload or remove logo =="
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X POST $B/logo -F logo=@/tmp/logo.png)
check "$CODE" "403" "non-admin blocked from logo upload"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X DELETE $B/logo)
check "$CODE" "403" "non-admin blocked from logo removal"

echo "== Remove logo reverts to no-logo state =="
req admin -X DELETE $B/logo > /dev/null
R=$(curl -s --noproxy '*' $B/branding)
check "$(echo $R | pyget "print(d['hasLogo'])")" "False" "logo removed successfully"

echo "== Cleanup: remove required custom field before budget tests =="
req admin -X DELETE $B/custom-fields/$CFID1 > /dev/null

echo "== Budget: register IT department (local copy of the real tracking sheet) =="
cp "$(dirname "$0")/samples/sample-budget-workbook.xlsx" /tmp/budget_it.xlsx
cp "$(dirname "$0")/samples/sample-budget-workbook.xlsx" /tmp/budget_hr.xlsx
req admin -X PUT $B/budget/config -H 'Content-Type: application/json' -d '{"config":{"policy":"block","required":true}}' > /dev/null
R=$(req admin -X POST $B/budget/departments -H 'Content-Type: application/json' -d '{"name":"IT","mode":"local","localPath":"/tmp/budget_it.xlsx"}')
check "$(echo $R | pyget "print(any(x['name']=='IT' for x in d['config']['departments']))")" "True" "IT department added"
DEPT_IT=$(echo $R | pyget "print([x['id'] for x in d['config']['departments'] if x['name']=='IT'][0])")
R=$(req admin -X POST $B/budget/departments -H 'Content-Type: application/json' -d '{"name":"HR","mode":"local","localPath":"/tmp/budget_hr.xlsx"}')
DEPT_HR=$(echo $R | pyget "print([x['id'] for x in d['config']['departments'] if x['name']=='HR'][0])")
check "$(echo $R | pyget "print(len(d['config']['departments']))")" "2" "two departments registered (IT, HR)"

echo "== Budget lines load per department =="
R=$(req zuhair "$B/budget/lines?dept=$DEPT_IT")
N=$(echo $R | pyget "print(len(d['lines']))")
check "$(echo $R | pyget "print(len(d['lines']) > 100)")" "True" "100+ IT budget lines parsed ($N found)"
check "$(echo $R | pyget "print(any(l['code']=='ACAH-CON-02' for l in d['lines']))")" "True" "ACAH-CON-02 (ISDN) line present"
check "$(echo $R | pyget "print(all(l['deptId']=='$DEPT_IT' for l in d['lines']))")" "True" "lines tagged with IT department id"
AVAIL_BEFORE=$(echo $R | pyget "print([l['available'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
AVAIL_CON03=$(echo $R | pyget "print([l['available'] for l in d['lines'] if l['code']=='ACAH-CON-03'][0])")
echo "  (ACAH-CON-02 available before: $AVAIL_BEFORE KD; ACAH-CON-03: $AVAIL_CON03 KD)"

echo "== Per-user department access: restrict Zuhair to IT only =="
req admin -X PUT "$B/users/$ZID/departments" -H 'Content-Type: application/json' -d "{\"departments\":[\"$DEPT_IT\"]}" > /dev/null
R=$(req zuhair $B/budget/departments/mine)
check "$(echo $R | pyget "print([x['name'] for x in d['departments']])")" "['IT']" "Zuhair sees only IT department"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' "$B/budget/lines?dept=$DEPT_HR")
check "$CODE" "403" "Zuhair blocked from HR department lines"

echo "== Request without budget line rejected (required=true) =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=NoBudget -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=50 -F currency=KWD -F description=test -F 'customFieldValues={}')
check "$(echo $R | pyget "print('budget line' in d.get('error','').lower())")" "True" "missing budget line rejected"

echo "== Unknown budget code rejected =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=BadCode -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=50 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"FAKE-XXX-99\",\"amount\":50}]")
check "$(echo $R | pyget "print('Unknown budget line' in d.get('error',''))")" "True" "unknown code rejected"

echo "== Split that doesn't sum to total rejected =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=BadSplit -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=100 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":40}]")
check "$(echo $R | pyget "print('must equal the request amount' in d.get('error',''))")" "True" "unbalanced split rejected"

echo "== Over-budget blocked under block policy =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=TooBig -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=999999 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":999999}]")
check "$(echo $R | pyget "print('Insufficient budget' in d.get('error',''))")" "True" "over-budget submission blocked"

echo "== Multi-line SPLIT request across two lines in IT (450 = 300 + 150) =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=MOC -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=450 -F currency=KWD -F 'description=ACAH-CON 50 Move ISDN to new vendor' -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":300},{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-03\",\"amount\":150}]")
RIDB=$(echo $R | pyget "print(d['request']['id'])")
check "$(echo $R | pyget "print(len(d['request']['budgetLines']))")" "2" "two budget lines frozen on request"
check "$(echo $R | pyget "print(sorted([l['code'] for l in d['request']['budgetLines']]))")" "['ACAH-CON-02', 'ACAH-CON-03']" "both codes recorded"
check "$(echo $R | pyget "print([l['logSheet'] for l in d['request']['budgetLines'] if l['code']=='ACAH-CON-02'][0])")" "ACAH Consumables Log" "correct log sheet resolved per line"
req layla -X POST $B/requests/$RIDB/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RIDB/decision -H 'Content-Type: application/json' -d '{"decision":"approved","financeUse":{"requestNo":"REQ-77","voucherNo":"","vendorNo":""}}' > /dev/null

echo "== Before Budget Supervisor approves: no hold yet =="
R=$(req zuhair "$B/budget/lines?dept=$DEPT_IT")
HELD_PRE=$(echo $R | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
check "$HELD_PRE" "0" "no hold before budget-supervisor stage"

echo "== Budget Supervisor approves -> both split amounts held on their own lines =="
req ahmed -X POST $B/requests/$RIDB/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req sara -X POST $B/requests/$RIDB/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req zuhair "$B/budget/lines?dept=$DEPT_IT")
HELD_02=$(echo $R | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
HELD_03=$(echo $R | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-03'][0])")
check "$HELD_02" "300" "ACAH-CON-02 holds its 300 split share"
check "$HELD_03" "150" "ACAH-CON-03 holds its 150 split share"

echo "== Finance Manager gives final approval — approved, not yet deducted =="
R=$(req nadia -X POST $B/requests/$RIDB/decision -H 'Content-Type: application/json' -d '{"decision":"approved","comment":"Final"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "approved" "split request fully approved"
check "$(echo $R | pyget "print(d['request'].get('budgetSync'))")" "None" "no sync attempted yet"

echo "== Accountant finalizes — both split rows written to the Log sheet =="
R=$(req fatima -X POST $B/requests/$RIDB/finalize -H 'Content-Type: application/json' -d '{"paymentRef":"Cheque #10234"}')
check "$(echo $R | pyget "print(d['request']['paymentFinalized']['by'])")" "Fatima" "finalized by Fatima"
# wait for the async sheet write to finish (poll the request's budgetSync status)
for i in $(seq 1 40); do
  ST=$(req admin $B/requests | pyget "print([r.get('budgetSync',{}).get('status') for r in d['requests'] if r['id']=='$RIDB'][0])" 2>/dev/null)
  [ "$ST" = "synced" ] && break
  [ "$ST" = "failed" ] && break
  sleep 0.3
done
check "$ST" "synced" "budget sync completed"
python3 - "$RIDB" <<'PYEOF'
import sys, openpyxl
prq = sys.argv[1]
wb = openpyxl.load_workbook('/tmp/budget_it.xlsx')
ws = wb['ACAH Consumables Log']
rows = [[c.value for c in row[:8]] for row in ws.iter_rows(min_row=4, max_row=80)]
mine = [r for r in rows if r[1] == prq]
codes = sorted([r[3] for r in mine])
amts = sorted([float(r[5]) for r in mine])
assert codes == ['ACAH-CON-02', 'ACAH-CON-03'], 'codes written: %r' % codes
assert amts == [150.0, 300.0], 'amounts written: %r' % amts
print('  both split rows written:', list(zip([r[3] for r in mine], [r[5] for r in mine])))
PYEOF
check "$?" "0" "both split lines (300 + 150) written to Log sheet"

echo "== After finalize: holds cleared, each line reduced by its share =="
R=$(req zuhair "$B/budget/lines?dept=$DEPT_IT&force=1")
HELD_02_AFTER=$(echo $R | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
AVAIL_02_AFTER=$(echo $R | pyget "print([l['available'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
AVAIL_03_AFTER=$(echo $R | pyget "print([l['available'] for l in d['lines'] if l['code']=='ACAH-CON-03'][0])")
check "$HELD_02_AFTER" "0" "hold cleared on ACAH-CON-02 after finalize"
python3 -c "
assert abs((float('$AVAIL_BEFORE') - float('$AVAIL_02_AFTER')) - 300) < 0.001, 'CON-02 should drop 300, got %s' % (float('$AVAIL_BEFORE')-float('$AVAIL_02_AFTER'))
assert abs((float('$AVAIL_CON03') - float('$AVAIL_03_AFTER')) - 150) < 0.001, 'CON-03 should drop 150'
print('  CON-02 -300, CON-03 -150, no double counting')"
check "$?" "0" "each line reduced by exactly its split share"

echo "== Double finalize blocked =="
R=$(req fatima -X POST $B/requests/$RIDB/finalize -H 'Content-Type: application/json' -d '{}')
check "$(echo $R | pyget "print('Already finalized' in d.get('error',''))")" "True" "cannot finalize twice"

echo "== Warn policy allows over-budget with flag =="
req admin -X PUT $B/budget/config -H 'Content-Type: application/json' -d '{"config":{"policy":"warn","required":true}}' > /dev/null
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=OverOk -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=999999 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-04\",\"amount\":999999}]")
check "$(echo $R | pyget "print(d['request']['budgetLines'][0]['overBudget'])")" "True" "warn policy accepts and flags over-budget"

echo "== Retry sync guards =="
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X POST $B/budget/sync/$RIDB)
check "$CODE" "403" "requestor cannot trigger sync"
R=$(req admin -X POST $B/budget/sync/$RIDB)
check "$(echo $R | pyget "print('Already synced' in d.get('error',''))")" "True" "double-sync blocked"

echo "== Finalize guard: cannot finalize before full approval =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=NotYetApproved -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=50 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-04\",\"amount\":50}]")
RIDC=$(echo $R | pyget "print(d['request']['id'])")
R=$(req fatima -X POST $B/requests/$RIDC/finalize -H 'Content-Type: application/json' -d '{}')
check "$(echo $R | pyget "print('fully approved' in d.get('error',''))")" "True" "cannot finalize a request still in the approval chain"

echo "== With budget not required, a no-line request is allowed =="
req admin -X PUT $B/budget/config -H 'Content-Type: application/json' -d '{"config":{"policy":"warn","required":false}}' > /dev/null
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=NoBudgetNeeded -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=10 -F currency=KWD -F description=test -F 'customFieldValues={}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_supervisor" "no-line request allowed when not required"

echo "== Budget columns in Excel export (split rendered) =="
req admin -o /tmp/export3.xlsx -w '' $B/export.xlsx
python3 - <<'PYEOF'
import openpyxl
wb = openpyxl.load_workbook('/tmp/export3.xlsx')
ws = wb['Payment Requests']
rows = list(ws.iter_rows(values_only=True))
header = rows[0]
assert 'Budget Line' in header and 'Budget Sync' in header and 'Payment Finalized' in header
bi, si, fi = header.index('Budget Line'), header.index('Budget Sync'), header.index('Payment Finalized')
vals = [(r[bi], r[si], r[fi]) for r in rows[1:] if r[bi]]
assert any('ACAH-CON-02' in str(v[0]) and 'ACAH-CON-03' in str(v[0]) and 'Synced' in str(v[1]) and 'Fatima' in str(v[2]) for v in vals), vals
print('  export split budget columns OK:', [v for v in vals if 'ACAH-CON-03' in str(v[0])][:1])
PYEOF
check "$?" "0" "Budget Line (split) + Sync + Finalized columns in export"

echo "== Access default (no restriction) sees all departments =="
req admin -X PUT "$B/users/$ZID/departments" -H 'Content-Type: application/json' -d '{"departments":[]}' > /dev/null
R=$(req zuhair $B/budget/departments/mine)
check "$(echo $R | pyget "print(sorted([x['name'] for x in d['departments']]))")" "['HR', 'IT']" "empty access list = all departments"

echo "== Configurable stage order: move Accountant to last =="
# put Accountant last: supervisor, budget, finance, accountant
req admin -X PUT $B/workflow -H 'Content-Type: application/json' -d '{"workflow":[{"key":"supervisor","enabled":true,"minAmount":0},{"key":"budget","enabled":true,"minAmount":0},{"key":"finance","enabled":true,"minAmount":0},{"key":"accountant","enabled":true,"minAmount":0}]}' > /dev/null
R=$(req admin $B/workflow)
check "$(echo $R | pyget "print([s['key'] for s in d['workflow']])")" "['supervisor', 'budget', 'finance', 'accountant']" "stage order saved as supervisor->budget->finance->accountant"
# new request should follow the new order
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=OrderTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=15 -F currency=KWD -F description=test -F 'customFieldValues={}')
RIDO=$(echo $R | pyget "print(d['request']['id'])")
check "$(echo $R | pyget "print(d['request']['chain'])")" "['supervisor', 'budget', 'finance', 'accountant']" "new request follows configured order"
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_supervisor" "still starts at supervisor"
# restore canonical order for the rest of the suite
req admin -X PUT $B/workflow -H 'Content-Type: application/json' -d '{"workflow":[{"key":"supervisor","enabled":true,"minAmount":0},{"key":"accountant","enabled":true,"minAmount":0},{"key":"budget","enabled":true,"minAmount":0},{"key":"finance","enabled":true,"minAmount":0}]}' > /dev/null
check "$(req admin $B/workflow | pyget "print([s['key'] for s in d['workflow']][1])")" "accountant" "order restored to canonical"

echo "== Invalid workflow (no enabled stage) rejected =="
R=$(req admin -X PUT $B/workflow -H 'Content-Type: application/json' -d '{"workflow":[{"key":"supervisor","enabled":false,"minAmount":0}]}')
check "$(echo $R | pyget "print('error' in d)")" "True" "workflow with no enabled stage rejected"

echo "== Signature/stamp self-service upload =="
python3 -c "from PIL import Image; Image.new('RGBA',(200,80),(0,0,0,0)).save('/tmp/sig.png')" 2>/dev/null || printf '\x89PNG\r\n\x1a\n' > /tmp/sig.png
python3 -c "from PIL import Image; Image.new('RGBA',(90,90),(0,0,0,0)).save('/tmp/stamp.png')" 2>/dev/null || printf '\x89PNG\r\n\x1a\n' > /tmp/stamp.png
req layla -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Layla","password":"Test12345"}' > /dev/null
CODE=$(req layla -o /dev/null -w '%{http_code}' -X POST $B/me/signature -F image=@/tmp/sig.png)
check "$CODE" "200" "supervisor uploads signature"
CODE=$(req layla -o /dev/null -w '%{http_code}' -X POST $B/me/stamp -F image=@/tmp/stamp.png)
check "$CODE" "200" "supervisor uploads stamp"
R=$(req layla $B/me/signature)
check "$(echo $R | pyget "print(d['hasSignature'] and d['hasStamp'])")" "True" "signature+stamp both present"
CODE=$(req layla -o /dev/null -w '%{http_code}' $B/signature/$LID/signature)
check "$CODE" "200" "signature image served"
echo "not an image" > /tmp/notimg.txt
R=$(req layla -X POST $B/me/signature -F image=@/tmp/notimg.txt)
check "$(echo $R | pyget "print('error' in d)")" "True" "non-image signature rejected"
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $B/signature/$LID/signature)
check "$CODE" "401" "signature requires auth to view"

echo "== Budget Supervisor can view budget lines (search list) =="
req ahmed -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Ahmed","password":"Test12345"}' > /dev/null
R=$(req ahmed $B/budget/lines)
check "$(echo $R | pyget "print(len(d['lines']) > 0)")" "True" "budget supervisor can read budget lines"
check "$(echo $R | pyget "print(any(l.get('deptName')=='IT' for l in d['lines']))")" "True" "lines carry department name for the supervisor view"
CODE=$(req ahmed -o /dev/null -w '%{http_code}' $B/budget/config)
check "$CODE" "403" "budget supervisor cannot read admin budget CONFIG"

echo "== Budget Supervisor edits a request before approving =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=BeforeEdit -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=100 -F currency=KWD -F 'description=original desc' -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":100}]")
RIDE=$(echo $R | pyget "print(d['request']['id'])")
req layla -X POST $B/requests/$RIDE/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Fatima","password":"Test12345"}' > /dev/null
req fatima -X POST $B/requests/$RIDE/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
# now at budget stage — Ahmed edits payee, amount, and rebalances the split to match
R=$(req ahmed -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d "{\"payeeName\":\"EditedPayee\",\"amount\":175,\"description\":\"revised description\",\"budgetLines\":\"[{\\\"deptId\\\":\\\"$DEPT_IT\\\",\\\"code\\\":\\\"ACAH-CON-02\\\",\\\"amount\\\":175}]\"}")
check "$(echo $R | pyget "print(d['request']['payeeName'])")" "EditedPayee" "budget supervisor edited payee"
check "$(echo $R | pyget "print(d['request']['amount'])")" "175" "budget supervisor edited amount"
check "$(echo $R | pyget "print(d['request']['budgetLines'][0]['amount'])")" "175" "split rebalanced to match new amount"
check "$(echo $R | pyget "print('accountant' in d['request']['approvals'] and 'supervisor' in d['request']['approvals'])")" "True" "earlier approvals kept after edit"
check "$(echo $R | pyget "print(any('Edited request' in l['action'] for l in d['request']['log']))")" "True" "edit is logged"

echo "== Editing amount without rebalancing the split is rejected =="
R=$(req ahmed -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d '{"amount":500}')
check "$(echo $R | pyget "print('unbalanced' in d.get('error','') or 'must equal' in d.get('error',''))")" "True" "amount change that unbalances split is blocked"

echo "== Budget Supervisor cannot edit requester =="
R=$(req ahmed -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d '{"requestorName":"Hacker"}')
check "$(echo $R | pyget "print(d['request']['requestorName'])")" "Zuhair" "requester name unchanged (not editable)"

echo "== Requester/other roles cannot use the edit endpoint =="
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d '{"amount":1}')
check "$CODE" "403" "requestor blocked from edit endpoint"

echo "== Budget team member who already voted can still edit; edit blocked once stage fully completes =="
req ahmed -X POST $B/requests/$RIDE/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req ahmed -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d '{"description":"still editable while team stage open"}')
check "$(echo $R | pyget "print(d['request']['description'])")" "still editable while team stage open" "team member can edit even after casting their own vote"
req sara -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"Sara","password":"Test12345"}' > /dev/null
req sara -X POST $B/requests/$RIDE/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
check "$(req admin $B/requests | pyget "print([r['status'] for r in d['requests'] if r['id']=='$RIDE'][0])")" "pending_finance" "both team votes in -> advanced to finance"
R=$(req ahmed -X PATCH $B/requests/$RIDE/edit -H 'Content-Type: application/json' -d '{"description":"too late"}')
check "$(echo $R | pyget "print('Budget Supervisor stage' in d.get('error',''))")" "True" "cannot edit after leaving budget stage"

echo "== Signature id recorded on approvals for print rendering =="
R=$(req admin $B/requests | pyget "print([r for r in d['requests'] if r['id']=='$RIDE'][0]['approvals']['supervisor'].get('byId')==\"$LID\")")
check "$R" "True" "approval records approver byId (drives signature on printout)"

echo "== Recall: requester pulls back a pending request, approvals cleared, holds released =="
# fresh request with a budget line so we can watch the hold
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=RecallTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=80 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":80}]")
RIDR=$(echo $R | pyget "print(d['request']['id'])")
HELD_R_PRE=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
# advance to budget stage and approve so a hold exists
req layla -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req ahmed -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req sara -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
HELD_BEFORE=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
python3 -c "assert abs((float('$HELD_BEFORE') - float('$HELD_R_PRE')) - 80) < 0.001, 'hold should rise 80, got %s' % (float('$HELD_BEFORE')-float('$HELD_R_PRE'))"
check "$?" "0" "hold rose by 80 after budget approval (awaiting finance)"
# requester recalls
R=$(req zuhair -X POST $B/requests/$RIDR/recall -H 'Content-Type: application/json' -d '{"reason":"wrong amount"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_supervisor" "recall returns request to first stage"
check "$(echo $R | pyget "print(len(d['request']['approvals']))")" "0" "recall cleared all approvals"
HELD_AFTER=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
check "$HELD_AFTER" "$HELD_R_PRE" "budget hold released after recall (back to pre-request level)"

echo "== Recall permissions and guards =="
CODE=$(req layla -o /dev/null -w '%{http_code}' -X POST $B/requests/$RIDR/recall -H 'Content-Type: application/json' -d '{}')
check "$CODE" "403" "a non-owner approver cannot recall someone else's request"
# fully approve then confirm recall is blocked
req layla -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req ahmed -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req sara -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req nadia -X POST $B/requests/$RIDR/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
R=$(req zuhair -X POST $B/requests/$RIDR/recall -H 'Content-Type: application/json' -d '{}')
check "$(echo $R | pyget "print('no longer be recalled' in d.get('error',''))")" "True" "cannot recall a fully approved request"

echo "== Send back: approver bounces a pending request to the start =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=SendBackTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=30 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":30}]")
RIDS=$(echo $R | pyget "print(d['request']['id'])")
req layla -X POST $B/requests/$RIDS/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
# now at accountant stage — Fatima sends it back
CODE=$(req fatima -o /dev/null -w '%{http_code}' -X POST $B/requests/$RIDS/send-back -H 'Content-Type: application/json' -d '{}')
check "$CODE" "400" "send-back requires a reason"
R=$(req fatima -X POST $B/requests/$RIDS/send-back -H 'Content-Type: application/json' -d '{"reason":"needs a quote attached"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "pending_supervisor" "send-back returns to first stage"
check "$(echo $R | pyget "print(len(d['request']['approvals']))")" "0" "send-back cleared approvals"
# an approver NOT at the current stage cannot send back
req layla -X POST $B/requests/$RIDS/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
CODE=$(req nadia -o /dev/null -w '%{http_code}' -X POST $B/requests/$RIDS/send-back -H 'Content-Type: application/json' -d '{"reason":"x"}')
check "$CODE" "409" "approver not at the current stage cannot send back"

echo "== Admin cancel: terminal state, holds released, guards =="
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=CancelTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=60 -F currency=KWD -F description=test -F 'customFieldValues={}' -F budgetDept=$DEPT_IT -F "budgetLines=[{\"deptId\":\"$DEPT_IT\",\"code\":\"ACAH-CON-02\",\"amount\":60}]")
RIDX=$(echo $R | pyget "print(d['request']['id'])")
HELD_X_PRE=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
req layla -X POST $B/requests/$RIDX/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req fatima -X POST $B/requests/$RIDX/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req ahmed -X POST $B/requests/$RIDX/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
req sara -X POST $B/requests/$RIDX/decision -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
HELD_C=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
python3 -c "assert abs((float('$HELD_C') - float('$HELD_X_PRE')) - 60) < 0.001"
check "$?" "0" "hold rose by 60 before cancel"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' -X POST $B/requests/$RIDX/cancel -H 'Content-Type: application/json' -d '{"reason":"x"}')
check "$CODE" "403" "non-admin cannot cancel"
R=$(req admin -X POST $B/requests/$RIDX/cancel -H 'Content-Type: application/json' -d '{}')
check "$(echo $R | pyget "print('reason is required' in d.get('error',''))")" "True" "cancel requires a reason"
R=$(req admin -X POST $B/requests/$RIDX/cancel -H 'Content-Type: application/json' -d '{"reason":"duplicate request"}')
check "$(echo $R | pyget "print(d['request']['status'])")" "cancelled" "admin cancelled the request"
check "$(echo $R | pyget "print(d['request']['cancelledBy'])")" "admin" "cancelledBy recorded"
HELD_C2=$(req zuhair "$B/budget/lines?dept=$DEPT_IT" | pyget "print([l['held'] for l in d['lines'] if l['code']=='ACAH-CON-02'][0])")
check "$HELD_C2" "$HELD_X_PRE" "hold released after cancel (back to pre-request level)"
R=$(req admin -X POST $B/requests/$RIDX/cancel -H 'Content-Type: application/json' -d '{"reason":"again"}')
check "$(echo $R | pyget "print('already' in d.get('error',''))")" "True" "cannot cancel an already-cancelled request"

echo "== Attachment storage config =="
R=$(req admin $B/attach-store)
check "$(echo $R | pyget "print(d['config']['mode'])")" "local" "attachment store defaults to local"
R=$(req admin -X PUT $B/attach-store -H 'Content-Type: application/json' -d '{"config":{"mode":"onedrive","shareLink":""}}')
check "$(echo $R | pyget "print('share link' in d.get('error','').lower() or 'graph env vars' in d.get('error','').lower())")" "True" "onedrive mode blocked without graph config / folder link"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' $B/attach-store)
check "$CODE" "403" "non-admin cannot read attachment store config"
# local mode round-trips fine
R=$(req admin -X PUT $B/attach-store -H 'Content-Type: application/json' -d '{"config":{"mode":"local"}}')
check "$(echo $R | pyget "print(d['config']['mode'])")" "local" "can switch attachment store back to local"

echo "== Attachment upload + serve (local mode round-trip) =="
printf '%%PDF-1.4 test pdf' > /tmp/att_test.pdf
R=$(req zuhair -X POST $B/requests -F department=IT -F payeeName=AttachTest -F 'paymentType=Supplier Payment' -F paymentMethod=Cheque -F amount=5 -F currency=KWD -F description=test -F 'customFieldValues={}' -F files=@/tmp/att_test.pdf)
RIDA=$(echo $R | pyget "print(d['request']['id'])")
ATTID=$(echo $R | pyget "print(d['request']['attachments'][0]['id'])")
check "$(echo $R | pyget "print(len(d['request']['attachments']))")" "1" "attachment recorded on request"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' $B/files/$ATTID)
check "$CODE" "200" "attachment served back to owner"
CODE=$(req zuhair -o /dev/null -w '%{http_code}' $B/files/nope)
check "$CODE" "404" "missing attachment 404s"

echo "== Database backup download (admin only) =="
CODE=$(req zuhair -o /dev/null -w '%{http_code}' $B/backup.db)
check "$CODE" "403" "non-admin cannot download the database backup"
req admin -o /tmp/backup_test.db -w '' $B/backup.db
# the downloaded file must be a valid SQLite database containing our data
python3 - <<'PYEOF'
import sqlite3, os
assert os.path.getsize('/tmp/backup_test.db') > 0, 'backup file is empty'
con = sqlite3.connect('/tmp/backup_test.db')
cur = con.cursor()
# header check: a real sqlite file starts with "SQLite format 3"
with open('/tmp/backup_test.db','rb') as f:
    assert f.read(15) == b'SQLite format 3', 'not a valid sqlite file'
nusers = cur.execute("SELECT COUNT(*) FROM users").fetchone()[0]
nreq = cur.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
assert nusers >= 8, 'backup missing users: %d' % nusers
assert nreq > 0, 'backup missing requests: %d' % nreq
con.close()
print('  backup OK: %d users, %d requests captured' % (nusers, nreq))
PYEOF
check "$?" "0" "backup is a valid SQLite file containing users + requests"
# backup should record itself in the audit log
check "$(req admin $B/audit | pyget "print(any('Downloaded database backup' in a['action'] for a in d['audit']))")" "True" "backup download is audit-logged"

echo "== Frontend served =="
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://localhost:3456/)
check "$CODE" "200" "index.html serves"
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://localhost:3456/app.js)
check "$CODE" "200" "app.js serves"

kill $SERVER_PID 2>/dev/null
sleep 1

echo "== Admin password reset script (server stopped) =="
node reset-admin-password.js 'ResetByScript123' > /tmp/reset_out.log 2>&1
check "$?" "0" "reset script runs successfully"
grep -q "Password reset for 1 admin" /tmp/reset_out.log
check "$?" "0" "reset script reports 1 admin updated"

ADMIN_PASSWORD='ShouldBeIgnored123' PORT=3456 node server.js > server.log 2>&1 &
SERVER_PID2=$!
for i in $(seq 1 30); do curl -s --noproxy '*' -o /dev/null http://localhost:3456/ && break; sleep 0.3; done
R=$(curl -s --noproxy '*' -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"admin","password":"Aca@Admin2026"}')
check "$(echo $R | pyget "print('error' in d)")" "True" "old admin password no longer works after reset"
R=$(curl -s --noproxy '*' -X POST $B/login -H 'Content-Type: application/json' -d '{"name":"admin","password":"ResetByScript123"}')
check "$(echo $R | pyget "print(d['user']['role'])")" "admin" "new password from reset script works"
check "$(echo $R | pyget "print(d['user']['mustChangePassword'])")" "True" "reset forces password change on next login"
kill $SERVER_PID2 2>/dev/null

echo
echo "================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================"
[ $FAIL -eq 0 ]
