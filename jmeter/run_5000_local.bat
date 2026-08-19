@echo off
SET JVM_ARGS=-Xms4g -Xmx10g
jmeter -n -t "c:\Users\imran.am.khan\OneDrive - Accenture\Documents\python\skribbl-app\jmeter\skribbl_e2e_game_flow.jmx" -JHOST=192.168.0.5 -JPORT=80 -JGAME_SESSIONS=4000 -JPLAYERS_PER_GAME=10 -JNUM_ROUNDS=2 -JTURN_DURATION=30 -JCONNECT_TIMEOUT=20000 -JREAD_TIMEOUT=30000 -JGAME_READ_TIMEOUT=60000 -JERROR_THRESHOLD_PCT=30 -l "c:\Users\imran.am.khan\OneDrive - Accenture\Documents\python\skribbl-app\jmeter\results\40000users.jtl"
