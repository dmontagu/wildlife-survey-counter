"""Count elk in elk5.jpg using CountGD via the HuggingFace Spaces API."""

from pathlib import Path

from gradio_client import Client, handle_file

IMAGE_PATH = Path('data/elk5.jpg')
OUTPUT_DIR = Path('output/elk5')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def main():
    print('Connecting to CountGD HuggingFace Space...')
    print('(Space may need to wake up — this could take a minute or two)')
    client = Client('nikigoli/countgd')

    print(f"\nSubmitting {IMAGE_PATH} with text prompt 'elk'...")
    # The CountGD space has a count_main function that takes:
    #   - image: the input image
    #   - text: text description of what to count
    #   - prompts: optional exemplar points (we'll skip for zero-shot)
    result = client.predict(
        image=handle_file(str(IMAGE_PATH)),
        text='elk',
        prompts=None,
        api_name='/count_main',
    )

    print(f'\nRaw result: {result}')

    # Result should be (output_image_path, count)
    if isinstance(result, list | tuple):
        if len(result) >= 2:
            output_image_path = result[0]
            count = result[1]
            print(f'\n{"=" * 60}')
            print(f'CountGD RESULT: {count} elk detected')
            print(f'{"=" * 60}')

            # Copy the output image to our output directory
            if output_image_path and Path(output_image_path).exists():
                import shutil

                dest = OUTPUT_DIR / 'elk5_countgd.jpg'
                shutil.copy2(output_image_path, dest)
                print(f'Output image saved to: {dest}')
        else:
            print(f'Unexpected result format: {result}')
    else:
        print(f'Unexpected result type: {type(result)} = {result}')


if __name__ == '__main__':
    main()
