# desafio, receber lista de números INT e achar a soma de dois numeros que dão o resultado


# def consecutive_numbers(lists, result):
#     dict = {}
#     for price, i in enumerate(lists):
#         calc = result - i
#         if calc in dict:
#             return calc, i
#         dict[i] = price
#         continue

#     return None


# if __name__ == "__main__":
#     print(consecutive_numbers([9,22,2,3,7,12,5], 14))
#     print(consecutive_numbers([9,22,2,3,7,12,5], 11))
#     print(consecutive_numbers([9,22,2,3,7,12,5], 25))
#     print(consecutive_numbers([9,22,2,3,7,12,5], 10))



# 📈 O Desafio
# Você receberá um array de inteiros chamado prices, onde prices[i] é o preço de uma determinada ação no dia i.

# Você deseja maximizar seu lucro escolhendo um único dia para comprar uma ação e escolhendo um dia diferente no futuro para vendê-la.

# Retorne o lucro máximo que você pode obter com essa transação. Se não for possível obter nenhum lucro (por exemplo, se os preços só caírem), retorne 0.
# Exemplos:
# Exemplo 1:

# Entrada: prices = [7, 1, 5, 3, 6, 4]
# Saída: 5
# Explicação: Compre no dia 2 (preço = 1) e venda no dia 5 (preço = 6). O lucro será 6 - 1 = 5. Note que comprar no dia 2 e vender no dia 1 não é permitido, porque você precisa comprar antes de vender.

# Exemplo 2:

# Entrada: prices = [7, 6, 4, 3, 1]
# Saída: 0
# Explicação: Neste caso, não há transação que gere lucro, pois os preços só diminuem. O lucro máximo é 0.

def best_day_to_buy(prices):
    seen = []
    current_profit = 0
    best_profit_day = {}
    for day, price in enumerate(prices):
        seen.append(price)
        if price > seen[day-1]:
            profit = price - seen[day-1]
            best_profit_day[day] = profit
    return max(best_profit_day, key=best_profit_day.get) if best_profit_day else 0

if __name__ == "__main__":
    print(best_day_to_buy([7, 6, 4, 3, 1]))
    print(best_day_to_buy([7, 1, 5, 3, 6, 4]))
    print(best_day_to_buy([221,214,4124,2424,52,2552,2578]))
    print(best_day_to_buy([1, 2, 5, 3, 6, 10]))