const axios = require('axios');
const { openaiApiKey } = require('../config/keys');

class AIService {
  constructor() {
    this.openaiClient = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async generateResponse(message, persona = 'wayneAI', callbacks) {
    try {
      const aiPersona = {
        wayneAI: {
          name: 'Wayne AI',
          role: '친절하고 도움이 되는 어시스턴트',
          traits: '전문적이고 통찰력 있는 답변을 제공하며, 사용자의 질문을 깊이 이해하고 명확한 설명을 제공합니다.',
          tone: '전문적이면서도 친근한 톤',
        },
        consultingAI: {
          name: 'Consulting AI',
          role: '비즈니스 컨설팅 전문가',
          traits: '비즈니스 전략, 시장 분석, 조직 관리에 대한 전문적인 조언을 제공합니다.',
          tone: '전문적이고 분석적인 톤',
        }
      }[persona];

      if (!aiPersona) {
        throw new Error('Unknown AI persona');
      }

      const systemPrompt = `당신은 ${aiPersona.name}입니다.
역할: ${aiPersona.role}
특성: ${aiPersona.traits}
톤: ${aiPersona.tone}

답변 시 주의사항:
1. 명확하고 이해하기 쉬운 언어로 답변하세요.
2. 정확하지 않은 정보는 제공하지 마세요.
3. 필요한 경우 예시를 들어 설명하세요.
4. ${aiPersona.tone}을 유지하세요.`;

      callbacks.onStart();

      const response = await this.openaiClient.post('/chat/completions', {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.7,
        stream: false
      });

      const content = response.data.choices[0].message.content;
      if (callbacks.onComplete) {
        await callbacks.onComplete({ content })
      }
      return content

    } catch (error) {
      console.error('AI response generation error:', error);
      callbacks.onError(error);
      throw new Error('AI 응답 생성 중 오류가 발생했습니다.');
    }
  }
}

module.exports = new AIService();