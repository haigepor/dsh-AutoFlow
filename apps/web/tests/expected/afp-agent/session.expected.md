{
  "events": [
    {
      "type": "agent-preset/selected",
      "agentPreset": "afp-curator"
    },
    {
      "type": "agent-preset/selected",
      "agentPreset": "standard"
    },
    {
      "type": "turn/end",
      "turn": 1,
      "reason": {
        "kind": "completed"
      }
    },
    {
      "type": "agent-preset/selected",
      "agentPreset": "afp-curator"
    },
    {
      "type": "tool/call",
      "name": "afp_search_plan",
      "arguments": "{\"query\":\"landscape\"}"
    },
    {
      "type": "tool/call",
      "name": "afp_history",
      "arguments": "{\"kind\":\"runs\",\"offset\":0,\"limit\":5}"
    },
    {
      "type": "turn/end",
      "turn": 2,
      "reason": {
        "kind": "completed"
      }
    },
    {
      "type": "agent-preset/selected",
      "agentPreset": "standard"
    },
    {
      "type": "agent-preset/selected",
      "agentPreset": "afp-curator"
    },
    {
      "type": "turn/end",
      "turn": 3,
      "reason": {
        "kind": "completed"
      }
    },
    {
      "type": "agent-preset/selected",
      "agentPreset": "standard"
    }
  ],
  "afpTools": [
    "afp_account",
    "afp_apply",
    "afp_category_plan",
    "afp_collection_items",
    "afp_collection_list",
    "afp_collection_plan",
    "afp_collections",
    "afp_diagnostics",
    "afp_download_directory",
    "afp_download_options",
    "afp_download_plan",
    "afp_history",
    "afp_operation_apply",
    "afp_photo_details",
    "afp_photo_search",
    "afp_photo_search_start",
    "afp_photo_selection",
    "afp_plan_change",
    "afp_refresh",
    "afp_report",
    "afp_result_page",
    "afp_run_control",
    "afp_run_items",
    "afp_search_plan",
    "afp_status",
    "ask_user_question",
    "job_kill",
    "job_list",
    "job_output",
    "read",
    "skill",
    "todo_write"
  ]
}
