import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

message = EmailMessage()
message['From'] = os.environ['SMTP_FROM']
message['To'] = sys.argv[1]
message['Subject'] = 'Definir sua senha no WhatsIA'
message.set_content('Use este link em até 30 minutos para definir sua senha no WhatsIA.\n\n' + sys.stdin.read())
with smtplib.SMTP(os.environ['SMTP_HOST'], int(os.getenv('SMTP_PORT', '587')), timeout=15) as client:
    client.starttls(context=ssl.create_default_context())
    if os.getenv('SMTP_USER'):
        client.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
    client.send_message(message)
