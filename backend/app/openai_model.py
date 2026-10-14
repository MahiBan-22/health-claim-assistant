"""Stateless Responses API transport. No tools, no saved provider conversation."""
import base64
from .config import settings
from .errors import ModelPaused

def status():
    config = settings()
    configured = bool(config.openai_api_key.get_secret_value())
    return {"connected": configured, "model_available": configured, "model": config.llm_model,
            "message": "OpenAI API key configured; access is verified when a request runs." if configured else "Configure OPENAI_API_KEY on the backend."}

def answer(prompt, image=None, suffix=".jpg"):
    import httpx
    config = settings()
    if not config.openai_api_key.get_secret_value():
        raise ModelPaused("Configure OPENAI_API_KEY on the backend.")
    content = [{"type": "input_text", "text": prompt}]
    if image is not None:
        media = "image/png" if suffix == ".png" else "image/jpeg"
        content.append({"type": "input_image", "image_url": "data:" + media + ";base64," + base64.b64encode(image).decode()})
    try:
        with httpx.Client(timeout=config.model_timeout_seconds) as client:
            response = client.post("https://api.openai.com/v1/responses",
                headers={"Authorization": "Bearer " + config.openai_api_key.get_secret_value()},
                json={"model": config.llm_model, "input": [{"role": "user", "content": content}],
                      "store": False, "max_output_tokens": 12000})
        if response.status_code in {401, 403}:
            raise ModelPaused("OpenAI rejected the backend API key or model access. Check the backend configuration.")
        if response.status_code == 429:
            raise ModelPaused("OpenAI usage or rate limit reached. Check API billing and retry later.")
        if response.status_code >= 400:
            raise ModelPaused("OpenAI request failed. Check model access and backend configuration, then resume.")
        body = response.json()
        if body.get("status") != "completed":
            raise ModelPaused("The model response was incomplete. Resume to retry this step.")
        output = "".join(part["text"] for item in body.get("output", []) if item.get("type") == "message"
                         for part in item.get("content", []) if part.get("type") == "output_text")
        if not output.strip():
            raise ModelPaused("The model returned no answer. Resume to retry this step.")
        return output, body.get("usage") or {}
    except (httpx.HTTPError, ValueError, KeyError) as error:
        raise ModelPaused("The OpenAI connection failed. Resume to retry this step.") from error
