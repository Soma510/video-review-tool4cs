import os
from google import genai
from google.genai import types

def test():
    try:
        config = types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=1024)
        )
        print("Success with thinking_budget!")
    except Exception as e:
        print("Error with thinking_budget:", e)

if __name__ == "__main__":
    test()
