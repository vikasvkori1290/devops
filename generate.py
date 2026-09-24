import json

with open('roadmap_data.json', 'r', encoding='utf-8') as f:
    roadmap_json = f.read().strip()

with open('template.html', 'r', encoding='utf-8') as f:
    template = f.read()

output = template.replace('__ROADMAP_PLACEHOLDER__', roadmap_json)

with open('DevOps Roadmap Tracker.html', 'w', encoding='utf-8') as f:
    f.write(output)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(output)

print("Generated DevOps Roadmap Tracker.html and index.html successfully!")
