#!/usr/bin/env python3
"""
Send a test SMS via Twilio to verify your A2P campaign is live.

Set credentials as environment variables before running:
  export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  export TWILIO_AUTH_TOKEN=your_auth_token
  export TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  export TEST_TO_NUMBER=+1XXXXXXXXXX

Then run:
  python3 send-test-sms.py
"""

import os
import urllib.request
import urllib.parse
import base64
import json

ACCOUNT_SID          = os.environ["TWILIO_ACCOUNT_SID"]
AUTH_TOKEN           = os.environ["TWILIO_AUTH_TOKEN"]
MESSAGING_SERVICE_SID = os.environ["TWILIO_MESSAGING_SERVICE_SID"]
TO_NUMBER            = os.environ["TEST_TO_NUMBER"]

BODY = (
    "ValueRad Reminder: Your MRI is tomorrow at 10:00 AM at Main Radiology. "
    "Please arrive 15 min early. Reply STOP to opt out. "
    "Reply HELP for assistance. Msg&Data rates may apply."
)

url = f"https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json"

payload = urllib.parse.urlencode({
    "MessagingServiceSid": MESSAGING_SERVICE_SID,
    "To": TO_NUMBER,
    "Body": BODY,
}).encode()

credentials = base64.b64encode(f"{ACCOUNT_SID}:{AUTH_TOKEN}".encode()).decode()

req = urllib.request.Request(
    url,
    data=payload,
    headers={
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    print(f"Sent!  SID: {result['sid']}  Status: {result['status']}")
except urllib.error.HTTPError as e:
    error = json.loads(e.read())
    print(f"Error {e.code}: {error.get('message')}  (code {error.get('code')})")
    print("See: https://www.twilio.com/docs/api/errors/" + str(error.get('code', '')))
