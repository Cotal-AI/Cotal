{
  "targets": [
    {
      "target_name": "peercred",
      "sources": ["native/peercred.c"],
      "conditions": [
        ["OS==\"linux\"", {
          "defines": ["_GNU_SOURCE"]
        }, {
          "sources": []
        }]
      ]
    }
  ]
}
